// The Linux device key (phase-accounts/06): there is NO hardware key store wired yet.
// TPM 2.0 exists on much of the fleet, but a tpm2-tss binding is a real dependency tree
// (libtss2 + an ABI per distro) this addon does not take on today — so this stub answers
// `probe()` with backend 'none' and rejects every key op with the typed EDEVICEKEY_NOHW.
// The TS layer then takes the DOCUMENTED software fallback (a safeStorage-wrapped key,
// docs/18) and reports exactly that — the vault's own `basic_text` precedent: an honest
// downgrade stated out loud, never a hardware claim we cannot back.

#include <node_api.h>
#include <stdlib.h>

static napi_value dk_make_string(napi_env env, const char* s) {
  napi_value v;
  napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v);
  return v;
}

static napi_value dk_probe(napi_env env, napi_callback_info info) {
  (void)info;
  napi_deferred deferred;
  napi_value promise, result, no;
  napi_create_promise(env, &deferred, &promise);
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "backend", dk_make_string(env, "none"));
  napi_get_boolean(env, 0, &no);
  napi_set_named_property(env, result, "hardwareBacked", no);
  napi_resolve_deferred(env, deferred, result);
  return promise;
}

static napi_value dk_reject_nohw(napi_env env, napi_callback_info info) {
  (void)info;
  napi_deferred deferred;
  napi_value promise, err;
  napi_create_promise(env, &deferred, &promise);
  napi_create_error(env, dk_make_string(env, "EDEVICEKEY_NOHW"),
                    dk_make_string(env, "device-key: no hardware key store on this platform"), &err);
  napi_reject_deferred(env, deferred, err);
  return promise;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
    { "probe", NULL, dk_probe, NULL, NULL, NULL, napi_default, NULL },
    { "open", NULL, dk_reject_nohw, NULL, NULL, NULL, napi_default, NULL },
    { "sign", NULL, dk_reject_nohw, NULL, NULL, NULL, napi_default, NULL },
    { "tryExport", NULL, dk_reject_nohw, NULL, NULL, NULL, napi_default, NULL },
    { "del", NULL, dk_reject_nohw, NULL, NULL, NULL, napi_default, NULL }
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
