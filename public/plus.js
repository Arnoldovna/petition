var cursor = document.querySelector(".cursor");

function moveCursor(x, y) {
    cursor.style.left = x + "px";
    cursor.style.top = y + "px";
}

document.addEventListener("mousemove", function(e) {
    moveCursor(e.pageX, e.pageY);
});
