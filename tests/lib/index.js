module.exports.readConfig = readConfig;

function readConfig() {
    var config;

    try {
        config = require('../config.json');
    } catch (e) {
        console.error('failed to read/parse config');
        console.error('ensure that you cp dist-config.json config.json');
        console.error(e);
        process.exit(1);
    }

    return config;
}
