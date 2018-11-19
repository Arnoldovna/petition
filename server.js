const express = require("express");
const app = express();
const hb = require("express-handlebars");
const database = require("./db.js");
const csurf = require("csurf");

var cookieSession = require("cookie-session");

app.use(
    cookieSession({
        secret: `I'm always angry.`,
        maxAge: 1000 * 60 * 60 * 24 * 14
    })
);

app.engine("handlebars", hb());
app.set("view engine", "handlebars");

app.use(
    require("body-parser").urlencoded({
        extended: false
    })
);

app.use(csurf());

app.use(function(req, res, next) {
    res.locals.csrfToken = req.csrfToken();
    next();
});

app.use(express.static("public"));

// app.get("/", (req, res) => {
//     res.redirect("/register");
// });

app.get("/home", (req, res) => {
    res.render("home", {
        layout: "main",
        title: "PETITION"
    });
});

app.get("/about", (req, res) => {
    res.render("about", {
        layout: "main",
        title: "PETITION"
    });
});

app.get("/signature", checkForUser, alreadySigned, (req, res) => {
    // console.log("REQ.SESSION.USER :", req.session.user);
    database
        .getName(req.session.user)
        .then(result => {
            console.log("FIRSTNAME : ", result.first);
            console.log("LASTNAME : ", result.last);

            req.session.first = result.first;
            req.session.last = result.last;
            // console.log("HELLO ", result);
            res.render("signature", {
                layout: "main",
                title: "PETITION",
                result: result
            });
        })
        .catch(err => {
            console.log("err in getNAME: ", err.message);
        });
});

app.post("/signature", (req, res) => {
    database
        .getData(req.body.signature, req.session.user)
        .then(result => {
            // console.log(result["rows"][0].id);
            // console.log("hhhhhh ", req.body)

            req.session.signatureId = result["rows"][0].id;
            console.log(
                "req.session.signatureID********",
                req.session.signatureId
            );
            res.redirect("/thankyou");
        })
        .catch(err => {
            console.log("err in getData: ", err);
        });
});

app.get("/register", loggedIn, (req, res) => {
    res.render("register", {
        layout: "main",
        title: "PETITION"
    });
});

app.post("/register", (req, res) => {
    database
        .hashPassword(req.body.password)
        .then(hash => {
            return database.insertNewUser(
                req.body.first,
                req.body.last,
                req.body.email,
                hash
            );
        })
        .then(result => {
            // console.log("RESULT VON REGISTER :", result["rows"][0]);
            req.session.user = result["rows"][0].id;

            res.redirect("/profile");
        })
        .catch(err => {
            console.log("err in /register POST: ", err.message);
            res.render("register", {
                layout: "main",
                title: "PETITION",
                error: "error"
            });
        });
});

app.get("/profile", checkForUser, (req, res) => {
    res.render("profile", {
        layout: "main",
        title: "PETITION"
    });
});

app.post("/profile", (req, res) => {
    // console.log("REQBODY***** ", req.body);

    if (req.body.age == "" && req.body.city == "" && req.body.homepage == "") {
        res.redirect("/signature");
    } else {
        database
            .insertProfile(
                req.body.age,
                req.body.city,
                req.body.homepage,
                req.session.user
            )
            .then(result => {
                console.log("INSERT PROFILE **** ", result["rows"][0]);
                // console.log("REQ.BODY.CITY *****", req.body.city);
                res.redirect("/signature");
            })

            .catch(err => {
                console.log("ERROR in  IF PROFILE POST: ", err.message);
            });
    }
});

app.get("/profile/edit", checkForUser, (req, res) => {
    console.log("req.session.user:", req.session.user);

    database
        .giveEditData(req.session.user)
        .then(edit => {
            console.log("EDIT****** :", edit);
            res.render("edit", {
                layout: "main",
                title: "PETITION",
                edit: edit
            });
        })
        .catch(err => {
            console.log("ERROR in EDIT GET: ", err.message);
        });
});

app.post("/profile/edit", (req, res) => {
    // console.log("REQ BODY :", req.body);

    database
        .updateUserProfiles(
            req.session.user,
            req.body.age,
            req.body.city,
            req.body.url
        )
        .then(update1 => {
            console.log("EDIT UPDATE USER PROFILES*****", update1);

            if (req.body.password === "") {
                // console.log("1*********************");
                return database.updateRegisteredWithOutPassword(
                    req.body.first,
                    req.body.last,
                    req.body.email,
                    req.session.user
                );
            } else {
                //if req.body.password == something
                // console.log("2***********************");
                return database.hashPassword(req.body.password).then(hash => {
                    return database.updateRegistered(
                        req.body.first,
                        req.body.last,
                        req.body.email,
                        hash,
                        req.session.user
                    );
                });
            }
        })
        .catch(err => {
            console.log("ERROR in /PROFILE/EDIT POST: ", err.message);
        })
        .then(value => {
            console.log(value);
            res.redirect("/supporter");
        });
});

app.get("/login", loggedIn, (req, res) => {
    res.render("logIn", {
        layout: "main",
        title: "PETITION"
    });
});

app.post("/login", (req, res) => {
    // console.log("REQ BODY :", req.body);
    database
        .dbPassword(req.body.email)
        .then(dbPass => {
            return database.checkPassword(req.body.password, dbPass);
        })
        .then(answer => {
            if (answer) {
                console.log("****THE LOGGIN WAS SUCCESSFUL****");
                database.getUserId(req.body.email).then(result => {
                    console.log("USER ID*****", result);
                    req.session.user = result;
                    console.log("req.session.user !!!!: ", req.session.user);
                    database.getSignatureId(req.session.user).then(sigId => {
                        if (sigId) {
                            req.session.signatureId = sigId;
                            console.log("sigId**************", req.session);
                            res.redirect("/thankyou");
                        } else {
                            res.redirect("/signature");
                        }
                    });
                });
            } else {
                console.log("ERROR: EMAIL ALREADY EXISTS");
                res.render("register", {
                    layout: "main",
                    title: "PETITION",
                    error: "error"
                });
            }
        })
        .catch(err => {
            console.log("ERROR in LOGIN POST: ", err.message);
            console.log("ERROR: PASSWORD DOESN'T MATCH");
            res.render("logIn", {
                layout: "main",
                title: "PETITION",
                error: "error"
            });
        });
});

app.get("/thankyou", checkForUser, (req, res) => {
    database.getNumber().then(numberSigners => {
        // console.log("NUMBER OF SIGNERS : ", numberSigners);
        database.getPic(req.session.signatureId).then(sig => {
            console.log("SSIIIIGG : ", sig);
            res.render("thankyou", {
                layout: "main",
                title: "PETITION",
                numberSigners: numberSigners,
                sig: sig
            });
        });
    });
});

app.get("/logout", (req, res) => {
    req.session = null;
    res.redirect("/register");
});

app.get("/supporter", checkForUser, (req, res) => {
    database
        .showAllSigners()
        .then(function(result) {
            console.log("SUPPORTER RESULT****:", result);
            res.render("supporter", {
                layout: "main",
                result: result,
                helpers: {
                    renderProfile: function(city, age) {
                        if (age && city) {
                            return `<span class="cities">${age}, <a href="/supporter/${city}" target="_blank">${city}</a></span>`;
                        } else if (age && !city) {
                            return `<span class="cities">${age}<span>`;
                        } else if (!age && city) {
                            return `<span class="cities"><a href="/supporter/${city}" target="_blank">${city}</a></span>`;
                        } else {
                            return "";
                        }
                    },
                    renderUser: function(url, first, last) {
                        if (url) {
                            return `<a class="links" href="https://${url}" target="_blank">${first} ${last}</a>`;
                        } else {
                            return `<span class="names">${first} ${last}</span>`;
                        }
                    }
                }
            });
        })
        .catch(function(err) {
            console.log("ERROR in SUPPORTER GET:", err.message);
        });
});

app.get("/supporter/:city", checkForUser, (req, res) => {
    console.log("REQ.PARAMS.city :", req.params.city);
    database
        .showCity(req.params.city)
        .then(function(result) {
            console.log("RESULT:ROWS*****", result);
            res.render("city", {
                layout: "main",
                result: result,
                helpers: {
                    renderProfile: function(city, age) {
                        if (age && city) {
                            return `<span class="cities">${age}, ${city}</span>`;
                        } else if (age && !city) {
                            return `<span class="cities">${age}<span>`;
                        } else if (!age && city) {
                            return `<span class="cities">${city}</span>`;
                        } else {
                            return "";
                        }
                    },
                    renderUser: function(url, first, last) {
                        if (url) {
                            return `<a class="links" href="https://${url}"target="_blank">${first} ${last}</a>`;
                        } else {
                            return `<span class="names">${first} ${last}</span>`;
                        }
                    }
                }
            });
        })
        .catch(err => {
            console.log("ERROR in SUPPORTER PARAMS: ", err.message);
        });
});

app.post("/signature/delete", checkForUser, (req, res) => {
    database
        .deleteSignature(req.session.user)
        .then(result => {
            console.log("**********RESULT******", result);
            req.session.signatureId = null;
            res.redirect("/signature");
        })
        .catch(err => {
            console.log("ERROR in DELETE SIGNATURE POST: ", err.message);
        });
});

app.post("/delete", checkForUser, (req, res) => {
    database
        .deleteSignature(req.session.user)
        .then(result => {
            console.log("*****DELETE SIGN RESULT***********", result);
            database.deleteProfile(req.session.user).then(answer => {
                console.log("*****DELETE PROFILE RESULT***********", answer);
                database.deleteRegister(req.session.user).then(third => {
                    req.session = null;
                    console.log(
                        "*****DELETE REGISTER RESULT***********",
                        third
                    );
                    res.redirect("/home");
                });
            });
        })
        .catch(err => {
            console.log("ERROR in DELETE ACCOUNT POST: ", err.message);
        });
});

app.get("*", (req, res) => {
    res.redirect("/home");
});
////////////////////////////////////////CHECK FUNKTIONEN ///////////////////////////

function checkForUser(req, res, next) {
    if (!req.session.user) {
        console.log("ABOUT TO REDIRECT***", req.session);
        res.redirect("/register");
    } else {
        next();
    }
}

function loggedIn(req, res, next) {
    if (req.session.user) {
        res.redirect("/signature");
    } else {
        next();
    }
}

function alreadySigned(req, res, next) {
    if (req.session.signatureId) {
        res.redirect("/supporter");
    } else {
        next();
    }
}

app.listen(process.env.PORT || 8080, () => {
    console.log("LISTENING ...");
});
