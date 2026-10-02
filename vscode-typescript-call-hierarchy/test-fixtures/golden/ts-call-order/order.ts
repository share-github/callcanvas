export function run(): void {
    outer(inner(1));
    new Chain().first().second();
    a(); b();
    wrap(
        arg()
    );
}

function inner(x: number): number { return x; }
function outer(x: number): number { return x; }
class Chain {
    first(): Chain { return this; }
    second(): void { }
}
function a(): void { }
function b(): void { }
function arg(): number { return 0; }
function wrap(x: number): number { return x; }
