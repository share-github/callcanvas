function startProcess() {
    const opts = { handleComplete };
    runWithOptions(opts);
}

function runWithOptions(options) {
    options.handleComplete("done");
}

function handleComplete(result) {
    logResult(result);
}

function logResult(data) {
    console.log(data);
}
