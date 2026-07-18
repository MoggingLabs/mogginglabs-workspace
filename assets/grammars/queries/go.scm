; Tag query for the brain (ADR 0018) — clean-room, the tags.scm SHAPE.
(function_declaration name: (identifier) @definition.function)
(method_declaration name: (field_identifier) @definition.method)
(type_declaration (type_spec name: (type_identifier) @definition.type))
(call_expression function: (identifier) @reference.call)
(call_expression function: (selector_expression field: (field_identifier) @reference.call))
(import_declaration) @import
