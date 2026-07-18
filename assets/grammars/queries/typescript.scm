; Tag query for the brain (ADR 0018) — clean-room, the tags.scm SHAPE: capture
; names bucket by prefix (definition.* / reference.* / import*), 03 extracts
; from the same captures. Kept small on purpose: names, calls, imports.
(function_declaration name: (identifier) @definition.function)
(class_declaration name: (type_identifier) @definition.class)
(interface_declaration name: (type_identifier) @definition.type)
(method_definition name: (property_identifier) @definition.method)
(call_expression function: (identifier) @reference.call)
(call_expression function: (member_expression property: (property_identifier) @reference.call))
(import_statement) @import
