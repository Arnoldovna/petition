const spicedPg = require("spiced-pg");
// const { dbUser, dbPassword } = require("./secrets.json");
const bcrypt = require("bcryptjs");

let secrets;
if (process.env.NODE_ENV === "production") {
    secrets = process.env;
} else {
    secrets = require("./secrets.json");
}

const dbUrl =
    process.env.DATABASE_URL ||
    `postgres:${secrets.dbUser}:${secrets.dbPassword}@localhost:5432/signature`;

const db = spicedPg(dbUrl);

exports.getData = function getData(signature, user_id) {
    return db.query(
        `INSERT INTO save (signature, user_id) VALUES ($1,$2) RETURNING id`,
        [signature, user_id]
    );
};

// getData("Marina", "Wilhelm", "asdfjkl");

// exports.queryAll = function queryAll() {
//     return db.query(`SELECT * FROM save`);
// };
//function queryAll().then(result => {
//     console.log(result);
// });

exports.getSignatureId = function(id) {
    return db
        .query(`SELECT id FROM save WHERE user_id = $1`, [id])
        .then(num => {
            console.log("NUUUMMM:", num);
            return num.rows[0].id;
        });
};

exports.getNumber = function() {
    return db.query(`SELECT COUNT (*) FROM save`).then(num => {
        console.log("NUM :", num);
        return num.rows[0].count;
    });
};

// exports.allSupporter = function() {
//     return db.query(`SELECT first, last FROM registered_users ORDER By id ASC`);
// };

exports.getName = function(id) {
    return db
        .query(`SELECT first, last FROM registered_users WHERE id = $1`, [id])
        .then(result => {
            return result.rows[0];
        });
};

exports.getPic = function(id) {
    return db
        .query(`SELECT signature FROM save WHERE id = $1`, [id])
        .then(sig => {
            return sig.rows[0] && sig.rows[0].signature;
        });
};

exports.insertNewUser = function(first, last, email, hashedPw) {
    const q = `
        INSERT INTO registered_users
        (first, last, email, password)
        VALUES
        ($1, $2, $3, $4)
        RETURNING id
    `;
    const params = [
        first || null,
        last || null,
        email || null,
        hashedPw || null
    ];

    return db.query(q, params);
};

exports.dbPassword = function(email) {
    return db
        .query(`SELECT password FROM registered_users WHERE email = $1`, [
            email
        ])
        .then(result => {
            console.log("RESULT: ", result);
            console.log("result.rows[0] : ", result.rows[0]);
            console.log("result.rows[0].password : ", result.rows[0].password);
            return result.rows[0].password;
        });
};

exports.hashPassword = function(plainTextPassword) {
    return new Promise(function(resolve, reject) {
        bcrypt.genSalt(function(err, salt) {
            if (err) {
                return reject(err);
            }
            bcrypt.hash(plainTextPassword, salt, function(err, hash) {
                if (err) {
                    return reject(err);
                }
                resolve(hash);
            });
        });
    });
};

exports.getUserId = function(email) {
    return db
        .query(`SELECT id FROM registered_users WHERE email = $1`, [email])
        .then(result => {
            return result.rows[0].id;
        });
};

exports.checkPassword = function(
    textEnteredInLoginForm,
    hashedPasswordFromDatabase
) {
    return new Promise(function(resolve, reject) {
        bcrypt.compare(
            textEnteredInLoginForm,
            hashedPasswordFromDatabase,
            function(err, doesMatch) {
                if (err) {
                    reject(err);
                } else {
                    resolve(doesMatch);
                }
            }
        );
    });
};

exports.insertProfile = function(age, city, homepage, user_id) {
    const q = `
        INSERT INTO user_profiles
        (age, city, url,user_id)
        VALUES
        ($1, $2, $3,$4)
        RETURNING *
    `;
    const params = [age, city, homepage, user_id];

    return db.query(q, params);
};

exports.showAllSigners = function() {
    return db
        .query(
            `SELECT registered_users.first, registered_users.last, user_profiles.age, user_profiles.city, user_profiles.url
    FROM registered_users
    JOIN user_profiles
    ON registered_users.id = user_profiles.user_id

    JOIN save
    ON registered_users.id =save.user_id
    ;`
        )
        .then(result => {
            return result.rows;
        });
};

exports.showCity = function(city) {
    return db
        .query(
            `SELECT registered_users.first, registered_users.last, user_profiles.age, user_profiles.city, user_profiles.url

        FROM registered_users
        JOIN user_profiles
        ON registered_users.id = user_profiles.user_id

        JOIN save
        ON registered_users.id =save.user_id
        WHERE  LOWER(city)=LOWER($1)
        ;`,
            [city || null]
        )
        .then(result => {
            return result.rows;
        });
};

exports.giveEditData = function(id) {
    return db
        .query(
            `SELECT registered_users.first, registered_users.last, registered_users.email, user_profiles.age, user_profiles.city, user_profiles.url

            FROM registered_users
            FULL OUTER JOIN user_profiles
            ON registered_users.id = user_profiles.user_id
            WHERE  registered_users.id = $1
            ;`,
            [id]
        )
        .then(result => {
            return result.rows[0];
        });
};

exports.updateRegistered = function(first, last, email, hash, id) {
    return db
        .query(
            `
            UPDATE registered_users SET first=$1,last=$2,email=$3,password=$4 WHERE id=$5;
            `,
            [first || null, last || null, email || null, hash || null, id]
        )
        .then(result => {
            return result.rows;
        });
};

exports.updateRegisteredWithOutPassword = function(first, last, email, id) {
    return db
        .query(
            `
            UPDATE registered_users SET first=$1,last=$2,email=$3 WHERE id=$4;
            `,
            [first || null, last || null, email || null, id]
        )
        .then(result => {
            return result.rows;
        });
};

exports.updateUserProfiles = function(user_id, age, city, url) {
    return db
        .query(
            `
            INSERT INTO user_profiles (user_id,age, city, url)
            VALUES ($1, $2, $3,$4)
            ON CONFLICT (user_id)
            DO UPDATE SET age = $2, city = $3, url=$4 ;
            `,
            [user_id, age || null, city || null, url || null]
        )
        .then(result => {
            return result.rows;
        });
};

exports.deleteSignature = function(id) {
    return db
        .query(
            `
            DELETE FROM save WHERE user_id=$1
            `,
            [id]
        )
        .then(result => {
            return result.rows[0];
        });
};

exports.deleteRegister = function(id) {
    return db
        .query(
            `
            DELETE FROM registered_users WHERE id=$1
            `,
            [id]
        )
        .then(result => {
            return result.rows[0];
        });
};

exports.deleteProfile = function(id) {
    return db
        .query(
            `
            DELETE FROM user_profiles WHERE user_id=$1
            `,
            [id]
        )
        .then(result => {
            return result.rows[0];
        });
};
