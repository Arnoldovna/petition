// Tables arrive in phase 1b (users, profiles, signatures; DATA-MODEL.md section 2). Until then the schema is empty,
// so `drizzle-kit generate` reports no changes and the schema drift check in CI has nothing to diff.
export {};
