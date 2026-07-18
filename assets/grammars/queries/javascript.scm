; Tag query for the brain (ADR 0018) — clean-room, the tags.scm SHAPE.
(function_declaration name: (identifier) @definition.function)
(class_declaration name: (identifier) @definition.class)
(method_definition name: (property_identifier) @definition.method)
(call_expression function: (identifier) @reference.call)
(call_expression function: (member_expression property: (property_identifier) @reference.call))
(import_statement) @import
