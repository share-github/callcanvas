function outer() {
  function inner() {
    helper();
  }
  register(inner);
}

function register(fn) {
  fn();
}

function helper() {
  console.log("ok");
}
