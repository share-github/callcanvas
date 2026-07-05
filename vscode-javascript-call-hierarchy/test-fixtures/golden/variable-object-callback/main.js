function verifyAuth() {
    const verifyOptions = {
        "callback": handleAuthVerificationResponse
    };
    processOptions(verifyOptions);
}

function processOptions(opts) {
    opts.callback("done");
}

function handleAuthVerificationResponse(result) {
    logResult(result);
}

function logResult(data) {
    console.log(data);
}
