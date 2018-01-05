const events = require('./events.js');

module.exports = class channel extends MessageChannel {
	port_1(fk_port) {
		fk_port(events(this.port1));
	}

	port_2(fk_port) {
		fk_port(events(this.port2));
	}
};
