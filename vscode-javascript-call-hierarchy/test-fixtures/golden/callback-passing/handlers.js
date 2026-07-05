function registerHandler(fn) {
    fn();
}

function onClick() {
    handleEvent();
}

function processItems(list, fn) {
    list.forEach(fn);
}

function transformItem(item) {
    formatOutput(item);
}

function handleEvent() {
    console.log("event");
}

function formatOutput(item) {
    console.log(item);
}
