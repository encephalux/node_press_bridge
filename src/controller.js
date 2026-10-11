module.exports = bridge => {
    const add = (req, res) => {
        res.end();
        bridge.register(req.data_waggon)
            .catch(err => null);
    };

    const update = (req, res) => {
        res.end();
        bridge.update(req.data_waggon).catch(err => null);
    };

    const remove = (req, res) => {
        res.end();
        bridge.remove(req.data_waggon).catch(err => null);
    };

    return {
        add,
        update,
        remove
    };
};