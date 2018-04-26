const worker = require('../../../dist/main/module.js');

worker({

	average(at_data) {
		return at_data.length;
	},

});
