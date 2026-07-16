{
  "targets": [
    {
      "target_name": "device_key",
      "defines": ["NAPI_VERSION=8"],
      "sources": [],
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/device_key_win.c"],
          "libraries": ["ncrypt.lib", "bcrypt.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": { "AdditionalOptions": ["/utf-8"] }
          }
        }],
        ["OS=='mac'", {
          "sources": ["src/device_key_mac.mm"],
          "libraries": [
            "-framework Security",
            "-framework CoreFoundation",
            "-framework Foundation"
          ],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
          }
        }],
        ["OS not in 'win mac'", {
          "sources": ["src/device_key_stub.c"]
        }]
      ]
    }
  ]
}
