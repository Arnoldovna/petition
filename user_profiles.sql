DROP TABLE IF EXISTS user_profiles;
CREATE TABLE user_profiles(
    id SERIAL PRIMARY KEY,
    age INT,
    city VARCHAR(100),
    url VARCHAR(300),
    user_id INT NOT NULL UNIQUE REFERENCES registered_users(id)
);
