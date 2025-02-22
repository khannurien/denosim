function *coucou() {
  console.log("1");
  yield;
  console.log("2");
  yield
  console.log("3");
}

function *tocard() {
  console.log("A");
  yield coucou().next();
}

if (import.meta.main) {
  const iterator = tocard();
  console.log(iterator.next());
}