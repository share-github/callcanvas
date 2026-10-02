function run() {
    outer(inner(1));
    first().second();
    a(); b();
    wrap(
        arg()
    );
}

function inner(x) { return x; }
function outer(x) { return x; }
function first() { return { second: second }; }
function second() { }
function a() { }
function b() { }
function arg() { return 0; }
function wrap(x) { return x; }
