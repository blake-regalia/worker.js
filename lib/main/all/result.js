const manifest = require('./manifest.js');

module.exports = class result extends manifest {
	static from(z_item) {
		if(z_item instanceof result) {
			return z_item;
		}
		else {
			return new result(z_item);
		}
	}

	constructor(z_result, z_transfer_paths=true) {
		super([z_result], z_transfer_paths);
	}

	prepend() {
		throw new Error('cannot prepend a result');
	}
};
