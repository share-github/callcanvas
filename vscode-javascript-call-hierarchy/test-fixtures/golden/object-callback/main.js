function startApp() {
    doRequest({
        success: onSuccess,
        error: onError
    });
}

function onSuccess(data) {
    renderResult(data);
}

function onError(err) {
    showError(err);
}
