console.log("about.js running");

const sectionTag = document.querySelector("section.shapes");

const {
    Engine,
    Render,
    Bodies,
    World,
    MouseConstraint,
    Composites,
    Query
} = Matter;

// what is the width and height of the page
const w = window.innerWidth;
const h = window.innerHeight;

const engine = Engine.create();
const renderer = Render.create({
    element: sectionTag,
    engine: engine,
    options: {
        height: h,
        width: w,
        background: "#000000",
        wireframes: false,
        pixelRatio: window.devicePixelRatio
    }
});

// have the ability to create a brand new shape
const createShape = function(x, y) {
    const randomNum = Math.random();

    if (randomNum > 0.9) {
        return Bodies.rectangle(x, y, 38, 50, {
            render: {
                sprite: {
                    texture: "outline-2x.png",
                    xScale: 0.5,
                    yScale: 0.5
                }
            }
        });
    } else {
        return Bodies.circle(x, y, 25, {
            render: {
                sprite: {
                    texture: "ball.png",
                    xScale: 0.5,
                    yScale: 0.5
                }
            }
        });
    }
};

const bigBall = Bodies.circle(w / 2, h / 2, Math.min(w / 4, h / 4), {
    isStatic: true,
    render: {
        fillStyle: "#ffffff"
    }
});

const wallOptions = {
    isStatic: true,
    render: {
        visible: false
    }
};

const ground = Bodies.rectangle(w / 2, h + 50, w + 100, 100, wallOptions);
const ceiling = Bodies.rectangle(w / 2, -50, w + 100, 100, wallOptions);
const leftWall = Bodies.rectangle(-50, h / 2, 100, h + 100, wallOptions);
const rightWall = Bodies.rectangle(w + 50, h / 2, 100, h + 100, wallOptions);

const mouseControl = MouseConstraint.create(engine, {
    element: sectionTag,
    constraint: {
        render: {
            visible: false
        }
    }
});

const initialShapes = Composites.stack(50, 50, 15, 5, 40, 40, function(x, y) {
    return createShape(x, y);
});

World.add(engine.world, [
    bigBall,
    ground,
    ceiling,
    leftWall,
    rightWall,
    mouseControl,
    initialShapes
]);

// when we click the page, add a new shape
document.addEventListener("click", function(event) {
    const shape = createShape(event.pageX, event.pageY);
    World.add(engine.world, shape);
});

// when we move our mouse, check matter for any collision
// does the mouse touch a body
document.addEventListener("mousemove", function(event) {
    const vector = { x: event.pageX, y: event.pageY };
    const hoveredShapes = Query.point(initialShapes.bodies, vector);

    hoveredShapes.forEach(shape => {
        shape.render.sprite = null;
        shape.render.fillStyle = "red";
    });
});

// run both the engine, and the renderer
Engine.run(engine);
Render.run(renderer);

// let time = 0
// const changeGravity = function () {
//   time = time + 0.001
//
//   engine.world.gravity.x = Math.sin(time)
//   engine.world.gravity.y = Math.cos(time)
//
//   requestAnimationFrame(changeGravity)
// }
//
// changeGravity()

window.addEventListener("deviceorientation", function(event) {
    engine.world.gravity.x = event.gamma / 30;
    engine.world.gravity.y = event.beta / 30;
});
