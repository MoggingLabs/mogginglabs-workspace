// The macOS device key (phase-accounts/06): a persisted ECDSA P-256 key whose private
// half lives inside the Secure Enclave (kSecAttrTokenIDSecureEnclave) — non-exportable
// by the silicon's own design: SecKeyCopyExternalRepresentation on an enclave private
// key fails, always, and this module exposes nothing softer.
//
// HONESTY over reach: enclave keys require working SEP hardware AND a keychain the
// process may write (an unsigned dev binary or a CI VM without SEP fails with
// errSecMissingEntitlement / errSecUnimplemented). Every such failure maps to the typed
// EDEVICEKEY_NOHW rejection so the TS layer takes the documented software fallback and
// SAYS so — this file never fakes a hardware answer it cannot give.
//
// All ops run as napi_async_work (I7): Security.framework calls block, sometimes for
// hundreds of milliseconds, and must never stall the main thread.

#import <Foundation/Foundation.h>
#include <Security/Security.h>
#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
  char name[DK_NAME_MAX + 1]; // the keychain application tag, utf8
  uint8_t digest[DK_DIGEST_MAX];
  size_t digest_len;
  // outputs
  int failed;              // 0 = success
  OSStatus status;         // best-effort diagnostic
  const char* errcode;     // "EDEVICEKEY_NOHW" | "EDEVICEKEY_NOKEY" | NULL
  uint8_t pub[65];
  size_t pub_len;
  uint8_t sig[DK_SIG_MAX]; // DER ECDSA signature (the TS layer converts to r||s)
  size_t sig_len;
  int attempted;
  int refused;
  int deleted;
} DkTask;

// ── Security.framework plumbing (worker thread; CF memory managed manually) ─────────

static CFDataRef dk_tag(const char* name) {
  return CFDataCreate(kCFAllocatorDefault, (const UInt8*)name, (CFIndex)strlen(name));
}

static CFMutableDictionaryRef dk_query(const char* name) {
  CFMutableDictionaryRef q =
      CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDataRef tag = dk_tag(name);
  CFDictionarySetValue(q, kSecClass, kSecClassKey);
  CFDictionarySetValue(q, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom);
  CFDictionarySetValue(q, kSecAttrApplicationTag, tag);
  // Enclave keys live in the DATA PROTECTION keychain; on macOS a query only sees it
  // when asked (10.15+). Without this the key would be re-created on every boot.
  CFDictionarySetValue(q, kSecUseDataProtectionKeychain, kCFBooleanTrue);
  CFRelease(tag);
  return q;
}

/** Look the named key up. Returns NULL when absent (out_status says why). */
static SecKeyRef dk_find_key(const char* name, OSStatus* out_status) {
  CFMutableDictionaryRef q = dk_query(name);
  CFDictionarySetValue(q, kSecReturnRef, kCFBooleanTrue);
  CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef ref = NULL;
  OSStatus st = SecItemCopyMatching(q, &ref);
  CFRelease(q);
  if (out_status) *out_status = st;
  return st == errSecSuccess ? (SecKeyRef)ref : NULL;
}

/** Create a PERSISTED Secure Enclave P-256 key under the tag. NULL on any failure —
 *  including "this machine/process cannot do enclave keys at all". */
static SecKeyRef dk_create_key(const char* name, OSStatus* out_status) {
  SecAccessControlRef access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, kSecAccessControlPrivateKeyUsage, NULL);
  if (!access) {
    if (out_status) *out_status = errSecParam;
    return NULL;
  }

  CFMutableDictionaryRef priv =
      CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDataRef tag = dk_tag(name);
  CFDictionarySetValue(priv, kSecAttrIsPermanent, kCFBooleanTrue);
  CFDictionarySetValue(priv, kSecAttrApplicationTag, tag);
  CFDictionarySetValue(priv, kSecAttrAccessControl, access);

  CFMutableDictionaryRef attrs =
      CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  int bits = 256;
  CFNumberRef size = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &bits);
  CFDictionarySetValue(attrs, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom);
  CFDictionarySetValue(attrs, kSecAttrKeySizeInBits, size);
  CFDictionarySetValue(attrs, kSecAttrTokenID, kSecAttrTokenIDSecureEnclave);
  CFDictionarySetValue(attrs, kSecUseDataProtectionKeychain, kCFBooleanTrue);
  CFDictionarySetValue(attrs, kSecPrivateKeyAttrs, priv);

  CFErrorRef err = NULL;
  SecKeyRef key = SecKeyCreateRandomKey(attrs, &err);
  if (!key && out_status) {
    *out_status = err ? (OSStatus)CFErrorGetCode(err) : errSecUnimplemented;
  }
  if (err) CFRelease(err);
  CFRelease(size);
  CFRelease(tag);
  CFRelease(attrs);
  CFRelease(priv);
  CFRelease(access);
  return key;
}

/** The 65-byte uncompressed X9.62 public point of the key. */
static int dk_public_point(SecKeyRef key, uint8_t out[65], size_t* out_len) {
  SecKeyRef pub = SecKeyCopyPublicKey(key);
  if (!pub) return 0;
  CFErrorRef err = NULL;
  CFDataRef data = SecKeyCopyExternalRepresentation(pub, &err);
  CFRelease(pub);
  if (err) CFRelease(err);
  if (!data) return 0;
  CFIndex len = CFDataGetLength(data);
  int ok = len == 65;
  if (ok) memcpy(out, CFDataGetBytePtr(data), 65);
  CFRelease(data);
  if (ok) *out_len = 65;
  return ok;
}

// ── The worker ───────────────────────────────────────────────────────────────────────

static void dk_execute(napi_env env, void* data) {
  (void)env; // worker thread: no JS calls allowed here
  DkTask* t = (DkTask*)data;

  @autoreleasepool {
    if (t->op == OP_PROBE) {
      // The only trustworthy probe is doing the thing: mint an EPHEMERAL enclave key
      // (kSecAttrIsPermanent absent) and throw it away. Failure = no usable enclave.
      CFMutableDictionaryRef attrs =
          CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
      int bits = 256;
      CFNumberRef size = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &bits);
      CFDictionarySetValue(attrs, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom);
      CFDictionarySetValue(attrs, kSecAttrKeySizeInBits, size);
      CFDictionarySetValue(attrs, kSecAttrTokenID, kSecAttrTokenIDSecureEnclave);
      CFErrorRef err = NULL;
      SecKeyRef probe = SecKeyCreateRandomKey(attrs, &err);
      if (err) CFRelease(err);
      CFRelease(size);
      CFRelease(attrs);
      if (probe) {
        CFRelease(probe);
      } else {
        t->failed = 1;
        t->errcode = "EDEVICEKEY_NOHW";
      }
      return;
    }

    if (t->op == OP_DELETE) {
      CFMutableDictionaryRef q = dk_query(t->name);
      OSStatus st = SecItemDelete(q);
      CFRelease(q);
      if (st == errSecSuccess) {
        t->deleted = 1;
      } else if (st != errSecItemNotFound) { // absent = no-op, not an error
        t->failed = 1;
        t->status = st;
      }
      return;
    }

    OSStatus st = errSecSuccess;
    SecKeyRef key = dk_find_key(t->name, &st);
    if (!key && t->op == OP_OPEN) {
      key = dk_create_key(t->name, &st);
      if (!key) {
        // No SEP, no signing entitlement, no writable data-protection keychain —
        // all the same honest answer: this process has no hardware key store.
        t->failed = 1;
        t->status = st;
        t->errcode = "EDEVICEKEY_NOHW";
        return;
      }
    }
    if (!key) {
      t->failed = 1;
      t->status = st;
      t->errcode = "EDEVICEKEY_NOKEY";
      return;
    }

    switch (t->op) {
      case OP_OPEN: {
        if (!dk_public_point(key, t->pub, &t->pub_len)) {
          t->failed = 1;
          t->errcode = NULL;
        }
        break;
      }
      case OP_SIGN: {
        CFDataRef digest = CFDataCreate(kCFAllocatorDefault, t->digest, (CFIndex)t->digest_len);
        CFErrorRef err = NULL;
        CFDataRef sig = SecKeyCreateSignature(key, kSecKeyAlgorithmECDSASignatureDigestX962SHA256, digest, &err);
        CFRelease(digest);
        if (err) {
          t->status = (OSStatus)CFErrorGetCode(err);
          CFRelease(err);
        }
        if (sig) {
          CFIndex len = CFDataGetLength(sig);
          if (len > 0 && len <= DK_SIG_MAX) {
            memcpy(t->sig, CFDataGetBytePtr(sig), (size_t)len);
            t->sig_len = (size_t)len;
          } else {
            t->failed = 1;
          }
          CFRelease(sig);
        } else {
          t->failed = 1;
        }
        break;
      }
      case OP_TRY_EXPORT: {
        // The point of this op is to FAIL: the enclave never releases private
        // material. Success is a broken invariant the smoke turns red on.
        t->attempted = 1;
        CFErrorRef err = NULL;
        CFDataRef out = SecKeyCopyExternalRepresentation(key, &err);
        if (err) CFRelease(err);
        if (out) {
          t->refused = 0;
          CFRelease(out);
        } else {
          t->refused = 1;
        }
        break;
      }
    }
    CFRelease(key);
  }
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
  if (st == napi_ok && !t->failed) {
    napi_value result;
    napi_create_object(env, &result);
    switch (t->op) {
      case OP_PROBE:
      case OP_OPEN:
        napi_set_named_property(env, result, "backend", dk_make_string(env, "secure-enclave"));
        napi_set_named_property(env, result, "hardwareBacked", dk_make_bool(env, 1));
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
    snprintf(msg, sizeof(msg), "device-key op %d failed: OSStatus %ld", t->op, (long)t->status);
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
    if (argc < 1 || napi_get_value_string_utf8(env, argv[0], t->name, DK_NAME_MAX, &len) != napi_ok || len == 0) {
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
    t->digest_len = blen;
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
