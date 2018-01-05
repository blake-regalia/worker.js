@include '../typed-arrays.jmacs'

@set shared_memory 'new SharedArrayBuffer'
@set transferable true

@{TypedArrays()}


// globals
module.exports = {
	exports: {
		ArrayBufferS: SharedArrayBuffer,
		ArrayBufferT: ArrayBuffer,
		@{memory_exports}
	},
};

