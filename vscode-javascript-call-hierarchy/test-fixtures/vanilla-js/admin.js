function adminInit() {
    var users = loadAllUsers();
    renderTable(users);
}

function loadAllUsers() {
    var records = [fetchUser(1), fetchUser(2), fetchUser(3)];
    return records;
}

function renderTable(users) {
    users.forEach(function(user) {
        var label = formatName(user.name);
        console.log(label);
    });
}
