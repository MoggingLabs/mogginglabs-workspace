// The Windows device key (phase-accounts/06): a persisted, NON-EXPORTABLE ECDSA P-256
// key in CNG's key storage. The Platform Crypto Provider (TPM) is preferred; when the
// machine has no TPM the Microsoft Software KSP holds the key instead — still
// non-exportable by provider policy and DPAPI-protected at rest, and the caller is told
// which it got (`backend`), never left to assume hardware. Non-exportability is BY
// CONSTRUCTION: the key is finalized without NCRYPT_ALLOW_EXPORT_FLAG, so the provider
// itself refuses NCryptExportKey for the private half — there is no code path here (or
// anywhere) that could exfiltrate it.
//
// Every export runs as napi_async_work (I7: key ops are async, post-boot — TPM calls
// can take hundreds of milliseconds and must never block the main thread). Handles are
// opened per call and freed before completion; NCrypt is thread-safe.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <ncrypt.h>
#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef MS_PLATFORM_CRYPTO_PROVIDER
#define MS_PLATFORM_CRYPTO_PROVIDER L"Microsoft Platform Crypto Provider"
#endif

#define DK_NAME_MAX 200
#define DK_DIGEST_MAX 64
#define DK_SIG_MAX 144

enum {
  OP_PROBE = 0,
  OP_OPEN = 1,
  OP_SIGN = 2,
  OP_TRY_EXPORT = 3,
  OP_DELETE = 4
};

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  int op;
  // inputs
  wchar_t name[DK_NAME_MAX + 1];
  BYTE digest[DK_DIGEST_MAX];
  DWORD digest_len;
  // outputs
  SECURITY_STATUS status;      // 0 = success; the NTE_* that stopped us otherwise
  const char* errcode;         // stable string code, or NULL
  char backend[16];            // "tpm" | "cng"
  int hardware;                // 1 = TPM-resident
  BYTE pub[65];                // 0x04 || X || Y (uncompressed P-256 point)
  DWORD pub_len;
  BYTE sig[DK_SIG_MAX];        // raw r||s from NCryptSignHash (64 bytes for P-256)
  DWORD sig_len;
  int attempted;               // tryExport: an export API exists and was called
  int refused;                 // tryExport: the provider refused it
  int deleted;
} DkTask;

// ── CNG plumbing ─────────────────────────────────────────────────────────────────────

static SECURITY_STATUS dk_open_provider(int tpm, NCRYPT_PROV_HANDLE* prov) {
  return NCryptOpenStorageProvider(prov, tpm ? MS_PLATFORM_CRYPTO_PROVIDER : MS_KEY_STORAGE_PROVIDER, 0);
}

/** Open the named key wherever it lives — TPM provider first, software KSP second.
 *  On success *is_tpm says which. NTE_BAD_KEYSET when it exists in neither. */
static SECURITY_STATUS dk_open_key(const wchar_t* name, NCRYPT_KEY_HANDLE* key, int* is_tpm) {
  SECURITY_STATUS last = NTE_BAD_KEYSET;
  for (int tpm = 1; tpm >= 0; tpm--) {
    NCRYPT_PROV_HANDLE prov = 0;
    if (dk_open_provider(tpm, &prov) != ERROR_SUCCESS) continue;
    SECURITY_STATUS st = NCryptOpenKey(prov, key, name, 0, 0);
    NCryptFreeObject(prov);
    if (st == ERROR_SUCCESS) {
      *is_tpm = tpm;
      return ERROR_SUCCESS;
    }
    last = st;
  }
  return last;
}

/** Create-if-absent. The key is finalized WITHOUT NCRYPT_ALLOW_EXPORT_FLAG — the
 *  provider enforces non-exportability from that moment on. */
static SECURITY_STATUS dk_open_or_create(const wchar_t* name, NCRYPT_KEY_HANDLE* key, int* is_tpm) {
  SECURITY_STATUS st = dk_open_key(name, key, is_tpm);
  if (st == ERROR_SUCCESS) return st;
  for (int tpm = 1; tpm >= 0; tpm--) {
    NCRYPT_PROV_HANDLE prov = 0;
    if (dk_open_provider(tpm, &prov) != ERROR_SUCCESS) continue;
    NCRYPT_KEY_HANDLE k = 0;
    st = NCryptCreatePersistedKey(prov, &k, BCRYPT_ECDSA_P256_ALGORITHM, name, 0, 0);
    if (st == NTE_EXISTS) { // lost a create race — the open above wins now
      st = NCryptOpenKey(prov, &k, name, 0, 0);
      NCryptFreeObject(prov);
      if (st == ERROR_SUCCESS) { *key = k; *is_tpm = tpm; return ERROR_SUCCESS; }
      continue;
    }
    if (st == ERROR_SUCCESS) st = NCryptFinalizeKey(k, 0);
    NCryptFreeObject(prov);
    if (st == ERROR_SUCCESS) {
      *key = k;
      *is_tpm = tpm;
      return ERROR_SUCCESS;
    }
    if (k) NCryptFreeObject(k);
  }
  return st;
}

/** BCRYPT_ECCPUBLIC_BLOB -> 65-byte uncompressed X9.62 point. */
static SECURITY_STATUS dk_export_public(NCRYPT_KEY_HANDLE key, BYTE out[65], DWORD* out_len) {
  BYTE blob[sizeof(BCRYPT_ECCKEY_BLOB) + 64];
  DWORD cb = 0;
  SECURITY_STATUS st = NCryptExportKey(key, 0, BCRYPT_ECCPUBLIC_BLOB, NULL, blob, sizeof(blob), &cb, 0);
  if (st != ERROR_SUCCESS) return st;
  BCRYPT_ECCKEY_BLOB* h = (BCRYPT_ECCKEY_BLOB*)blob;
  if (h->cbKey != 32 || cb < sizeof(BCRYPT_ECCKEY_BLOB) + 64) return NTE_BAD_TYPE;
  out[0] = 0x04;
  memcpy(out + 1, blob + sizeof(BCRYPT_ECCKEY_BLOB), 64);
  *out_len = 65;
  return ERROR_SUCCESS;
}

// ── The worker ───────────────────────────────────────────────────────────────────────

static void dk_execute(napi_env env, void* data) {
  (void)env; // worker thread: no JS calls allowed here
  DkTask* t = (DkTask*)data;
  t->status = ERROR_SUCCESS;

  if (t->op == OP_PROBE) {
    NCRYPT_PROV_HANDLE prov = 0;
    if (dk_open_provider(1, &prov) == ERROR_SUCCESS) {
      strcpy_s(t->backend, sizeof(t->backend), "tpm");
      t->hardware = 1;
      NCryptFreeObject(prov);
    } else if (dk_open_provider(0, &prov) == ERROR_SUCCESS) {
      strcpy_s(t->backend, sizeof(t->backend), "cng");
      NCryptFreeObject(prov);
    } else {
      t->errcode = "EDEVICEKEY_NOHW";
      t->status = NTE_NOT_SUPPORTED;
    }
    return;
  }

  NCRYPT_KEY_HANDLE key = 0;
  int is_tpm = 0;

  if (t->op == OP_OPEN) {
    t->status = dk_open_or_create(t->name, &key, &is_tpm);
    if (t->status == ERROR_SUCCESS) {
      strcpy_s(t->backend, sizeof(t->backend), is_tpm ? "tpm" : "cng");
      t->hardware = is_tpm;
      t->status = dk_export_public(key, t->pub, &t->pub_len);
    } else if (t->status == NTE_NOT_SUPPORTED) {
      t->errcode = "EDEVICEKEY_NOHW";
    }
  } else {
    t->status = dk_open_key(t->name, &key, &is_tpm);
    if (t->status != ERROR_SUCCESS) {
      if (t->op == OP_DELETE && t->status == NTE_BAD_KEYSET) {
        t->status = ERROR_SUCCESS; // deleting an absent key is a no-op, not an error
        t->deleted = 0;
      } else {
        t->errcode = t->status == NTE_BAD_KEYSET ? "EDEVICEKEY_NOKEY" : NULL;
      }
      if (t->status != ERROR_SUCCESS || t->op == OP_DELETE) return;
    }
  }

  if (t->status == ERROR_SUCCESS) {
    switch (t->op) {
      case OP_OPEN:
        break; // done above
      case OP_SIGN: {
        DWORD cb = 0;
        t->status = NCryptSignHash(key, NULL, t->digest, t->digest_len, t->sig, DK_SIG_MAX, &cb, 0);
        if (t->status == ERROR_SUCCESS) t->sig_len = cb;
        break;
      }
      case OP_TRY_EXPORT: {
        // The point of this op is to FAIL: both private-blob export shapes must be
        // refused by the provider. Success here is a broken invariant the smoke
        // turns red on — never something to hide.
        t->attempted = 1;
        DWORD cb = 0;
        SECURITY_STATUS a = NCryptExportKey(key, 0, BCRYPT_ECCPRIVATE_BLOB, NULL, NULL, 0, &cb, 0);
        SECURITY_STATUS b = NCryptExportKey(key, 0, NCRYPT_PKCS8_PRIVATE_KEY_BLOB, NULL, NULL, 0, &cb, 0);
        t->refused = (a != ERROR_SUCCESS) && (b != ERROR_SUCCESS);
        break;
      }
      case OP_DELETE: {
        t->status = NCryptDeleteKey(key, 0);
        if (t->status == ERROR_SUCCESS) {
          t->deleted = 1;
          key = 0; // NCryptDeleteKey frees the handle on success
        }
        break;
      }
    }
  }

  if (key) NCryptFreeObject(key);
}

static napi_value dk_make_string(napi_env env, const char* s) {
  napi_value v;
  napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v);
  return v;
}

static napi_value dk_make_bool(napi_env env, int b) {
  napi_value v;
  napi_get_boolean(env, b, &v);
  return v;
}

static void dk_complete(napi_env env, napi_status st, void* data) {
  DkTask* t = (DkTask*)data;
  if (st == napi_ok && t->status == ERROR_SUCCESS) {
    napi_value result;
    napi_create_object(env, &result);
    switch (t->op) {
      case OP_PROBE:
      case OP_OPEN:
        napi_set_named_property(env, result, "backend", dk_make_string(env, t->backend));
        napi_set_named_property(env, result, "hardwareBacked", dk_make_bool(env, t->hardware));
        if (t->op == OP_OPEN) {
          napi_value buf;
          void* out;
          napi_create_buffer_copy(env, t->pub_len, t->pub, &out, &buf);
          napi_set_named_property(env, result, "publicKey", buf);
        }
        break;
      case OP_SIGN: {
        void* out;
        napi_create_buffer_copy(env, t->sig_len, t->sig, &out, &result);
        break;
      }
      case OP_TRY_EXPORT:
        napi_set_named_property(env, result, "attempted", dk_make_bool(env, t->attempted));
        napi_set_named_property(env, result, "refused", dk_make_bool(env, t->refused));
        break;
      case OP_DELETE:
        napi_get_boolean(env, t->deleted, &result);
        break;
    }
    napi_resolve_deferred(env, t->deferred, result);
  } else {
    char msg[128];
    snprintf(msg, sizeof(msg), "device-key op %d failed: NCrypt status 0x%08lX", t->op, (unsigned long)t->status);
    napi_value err;
    napi_value message = dk_make_string(env, msg);
    napi_create_error(env, t->errcode ? dk_make_string(env, t->errcode) : NULL, message, &err);
    napi_reject_deferred(env, t->deferred, err);
  }
  napi_delete_async_work(env, t->work);
  free(t);
}

// ── The JS surface: probe() / open(name) / sign(name, digest) / tryExport(name) / del(name) ──

static napi_value dk_start(napi_env env, napi_callback_info info, int op, int want_name, int want_digest) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  DkTask* t = (DkTask*)calloc(1, sizeof(DkTask));
  if (!t) {
    napi_throw_error(env, NULL, "device-key: out of memory");
    return NULL;
  }
  t->op = op;

  if (want_name) {
    size_t len = 0;
    if (argc < 1 || napi_get_value_string_utf16(env, argv[0], (char16_t*)t->name, DK_NAME_MAX, &len) != napi_ok || len == 0) {
      free(t);
      napi_throw_type_error(env, NULL, "device-key: key name (string) required");
      return NULL;
    }
  }
  if (want_digest) {
    void* bytes = NULL;
    size_t blen = 0;
    if (argc < 2 || napi_get_buffer_info(env, argv[1], &bytes, &blen) != napi_ok || blen == 0 || blen > DK_DIGEST_MAX) {
      free(t);
      napi_throw_type_error(env, NULL, "device-key: digest (Buffer, <=64 bytes) required");
      return NULL;
    }
    memcpy(t->digest, bytes, blen);
    t->digest_len = (DWORD)blen;
  }

  napi_value promise;
  napi_create_promise(env, &t->deferred, &promise);
  napi_value resource_name = dk_make_string(env, "device-key");
  napi_create_async_work(env, NULL, resource_name, dk_execute, dk_complete, t, &t->work);
  napi_queue_async_work(env, t->work);
  return promise;
}

static napi_value dk_probe(napi_env env, napi_callback_info info) { return dk_start(env, info, OP_PROBE, 0, 0); }
static napi_value dk_open(napi_env env, napi_callback_info info) { return dk_start(env, info, OP_OPEN, 1, 0); }
static napi_value dk_sign(napi_env env, napi_callback_info info) { return dk_start(env, info, OP_SIGN, 1, 1); }
static napi_value dk_try_export(napi_env env, napi_callback_info info) { return dk_start(env, info, OP_TRY_EXPORT, 1, 0); }
static napi_value dk_del(napi_env env, napi_callback_info info) { return dk_start(env, info, OP_DELETE, 1, 0); }

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
    { "probe", NULL, dk_probe, NULL, NULL, NULL, napi_default, NULL },
    { "open", NULL, dk_open, NULL, NULL, NULL, napi_default, NULL },
    { "sign", NULL, dk_sign, NULL, NULL, NULL, napi_default, NULL },
    { "tryExport", NULL, dk_try_export, NULL, NULL, NULL, napi_default, NULL },
    { "del", NULL, dk_del, NULL, NULL, NULL, napi_default, NULL }
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
