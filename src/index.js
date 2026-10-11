const env = require("./env");

if(!env.DIR)
    env.DIR = `${process.cwd()}/press_bridge`;

module.exports = {
    Bridge: require("./Bridge"),
    middleware: require("./middleware"),
    controllers: require("./controllers"),
    env: require("./env"),
    utils: require("./utils")
};