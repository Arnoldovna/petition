CREATE TYPE "public"."signature_method" AS ENUM('drawn', 'typed');--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"age" smallint,
	"city" text,
	"homepage_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_age_chk" CHECK ("profiles"."age" BETWEEN 1 AND 120),
	CONSTRAINT "profiles_city_chk" CHECK ("profiles"."city" = btrim("profiles"."city") AND "profiles"."city" !~ '\s{2,}' AND char_length("profiles"."city") BETWEEN 1 AND 100),
	CONSTRAINT "profiles_homepage_url_chk" CHECK (char_length("profiles"."homepage_url") <= 300 AND "profiles"."homepage_url" ~ '^https?://[^\s]+$')
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "signatures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"method" "signature_method" NOT NULL,
	"image" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signatures_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "signatures_image_size_chk" CHECK (octet_length("signatures"."image") BETWEEN 67 AND 65536),
	CONSTRAINT "signatures_image_png_chk" CHECK (substring("signatures"."image" FROM 1 FOR 8) = '\x89504e470d0a1a0a'::bytea)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"session_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_first_name_chk" CHECK ("users"."first_name" = btrim("users"."first_name") AND char_length("users"."first_name") BETWEEN 1 AND 100 AND "users"."first_name" !~ '[[:cntrl:]]'),
	CONSTRAINT "users_last_name_chk" CHECK ("users"."last_name" = btrim("users"."last_name") AND char_length("users"."last_name") BETWEEN 1 AND 100 AND "users"."last_name" !~ '[[:cntrl:]]'),
	CONSTRAINT "users_email_chk" CHECK ("users"."email" = lower(btrim("users"."email")) AND char_length("users"."email") BETWEEN 3 AND 254 AND position('@' in "users"."email") > 1),
	CONSTRAINT "users_password_hash_chk" CHECK ("users"."password_hash" LIKE '$argon2id$%'),
	CONSTRAINT "users_session_version_chk" CHECK ("users"."session_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profiles_city_key_idx" ON "profiles" USING btree (lower("city" COLLATE "pg_c_utf8"));--> statement-breakpoint
CREATE INDEX "signatures_created_at_id_idx" ON "signatures" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));