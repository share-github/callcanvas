function fetchUser(id) {
    var name = formatName("user" + id);
    var date = formatDate(new Date());
    return { id: id, name: name, date: date };
}
