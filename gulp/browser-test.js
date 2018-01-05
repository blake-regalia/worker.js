
module.exports = Object.assign(function(gulp, $, p_src, p_dest) {
	const browserify = require('browserify');

	// load source files
	return gulp.src(this.options.test_src, {read:false})
		.pipe($.debug())

		// transform file objects with gulp-tap
		.pipe($.tap((h_file) => {
			// browserify
			h_file.contents = browserify({
				entries: [h_file.path],
				debug: true,
			}).bundle();
		}))

		// transform streaming contents into buffer contents
		.pipe($.buffer())

		// // rename
		.pipe($.rename((...a_args) => {
			if(this.options.rename) this.options.rename(...a_args);
		}))

		// output
		.pipe(gulp.dest(p_dest));
}, {
	dependencies: [
		'browserify',
		'gulp-tap',
		'gulp-log',
		'vinyl-buffer',
		'vinyl-source-stream',
		'gulp-sourcemaps',
		'gulp-rename',
		'gulp-debug',
	],
});
