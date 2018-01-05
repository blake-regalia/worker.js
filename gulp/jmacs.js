const path = require('path');

module.exports = Object.assign(function(gulp, $, p_src, p_dest) {
	const jmacs = require('jmacs');

	// runs jmacs
	const mk_jmacs = (h_define={}) => {
		let s_define = '';
		// set global definitions
		if(h_define) {
			for(let s_define_property in h_define) {
				s_define += `@set ${s_define_property} ${JSON.stringify(h_define[s_define_property])}\n`;
			}
		}

		// tap stream
		return $.tap((h_file) => {
			// process contents as string through jmacs
			try {
				let s_file_contents = h_file.contents.toString();
				let h_result = jmacs.compile({
					input: s_define+s_file_contents,
					cwd: path.dirname(h_file.path),
				});

				if(h_result.error) {
					console.dir(h_result);
					console.dir(h_result.error);
					console.dir(h_result.error.message);
					console.log(h_result.error.message);
					throw `error while compiling ${h_file.path}\n\n${h_result.error.message}`;
				}

				h_file.contents = new Buffer(
					h_result.output.replace(/\/\*+\s*whitespace\s*\*+\/\s*/g, '')
				);
			}
			catch(e_compile) {
				throw 'error while compiling '+h_file.path+'\n\n'+e_compile.stack;
			}
		});
	};


	gulp.src(p_src+'/**/*.js')
		// set macro variables and then apply jmacs
		.pipe(mk_jmacs(this.config.jmacs))

		// beautify
		.pipe($.beautify({indent_with_tabs:true}))

		// outpt
		.pipe(gulp.dest(p_dest));
}, {
	dependencies: [
		'jmacs',
		'gulp-tap',
		'gulp-beautify',
	],
});
