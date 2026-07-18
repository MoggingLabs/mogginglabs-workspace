; Tag query for the brain (ADR 0018) — clean-room, the tags.scm SHAPE.
(function_definition declarator: (function_declarator declarator: (identifier) @definition.function))
(class_specifier name: (type_identifier) @definition.class)
(struct_specifier name: (type_identifier) @definition.type)
(call_expression function: (identifier) @reference.call)
(call_expression function: (field_expression field: (field_identifier) @reference.call))
(preproc_include) @import
