; Tag query for the brain (ADR 0018) — clean-room, the tags.scm SHAPE.
(class_declaration name: (identifier) @definition.class)
(interface_declaration name: (identifier) @definition.type)
(method_declaration name: (identifier) @definition.method)
(invocation_expression function: (identifier) @reference.call)
(invocation_expression function: (member_access_expression name: (identifier) @reference.call))
(using_directive) @import
