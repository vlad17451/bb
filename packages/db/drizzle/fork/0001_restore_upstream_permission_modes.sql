UPDATE `hosts` SET `max_permission_mode` = 'auto' WHERE `max_permission_mode` = 'read-only';
--> statement-breakpoint
UPDATE `project_execution_defaults` SET `permission_mode` = 'auto' WHERE `permission_mode` = 'read-only';
--> statement-breakpoint
UPDATE `queued_thread_messages` SET `permission_mode` = 'auto' WHERE `permission_mode` = 'read-only';
