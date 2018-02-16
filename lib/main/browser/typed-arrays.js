@include '../typed-arrays.jmacs'

@set shared_memory 'new SharedArrayBuffer'
@set transferable true

if('undefined' === typeof SharedArrayBuffer) {
	global.SharedArrayBuffer = function() {
		throw new Error('SharedArrayBuffer is not supported by this browser, or it is currently disabled due to Spectre');
	};
}

@{TypedArrays()}


// globals
module.exports = {
	exports: {
		ArrayBufferS: SharedArrayBuffer,
		ArrayBufferT: ArrayBuffer,
		@{memory_exports}
	},
};

