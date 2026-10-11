const env = require("./env");

if(!env.DIR)
    env.DIR = `${process.cwd()}/press_bridge`;

module.exports = {
    Bridge: require("./Bridge"),
    middleware: require("./middleware"),
    controller: require("./controller"),
    env: require("./env"),
    utils: require("./utils")
};