DROP TABLE IF EXISTS save;

CREATE TABLE save(
    id SERIAL PRIMARY KEY,
    signature TEXT NOT NULL,
    user_id INT NOT NULL UNIQUE REFERENCES registered_users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);