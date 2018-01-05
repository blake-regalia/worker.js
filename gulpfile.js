
// gulp
const gulp = require('gulp');
const soda = require('gulp-soda');

// gulp user-level config
let user_config = {};
try { user_config = require('./config.user.js'); }
catch(e) {}

// specify how config targets map to tasks
soda(gulp, {

	// global config object
	config: user_config,

	//
	inputs: {
		debug: 'js',
		main: ['js', 'test', 'bundle: test'],
	},

	//
	targets: {
		// direct javascript
		js: [
			'jmacs',
			'develop: jmacs',
		],

		test: [
			'mocha',
		],

		bundle: [
			'browser-test',
		],
	},

	options: {
		copy: {
			glob: '*.js',
		},

		'*': {
			test_src: ['test/main/module.js'],
		},

		'browser-test': {
			rename: (h) => h.basename = 'bundle',
		},
	},

	aliases: {
		test: ['mocha'],
	},
});
