const shmmap = require('shmmap');

@include '../typed-arrays.jmacs'

@set shared_memory 'shmmap.create'
@set transferable false

@def create_shareable_memory(s_local, s_how)
	// create shared memory segment
	let [s_key, db_shared] = @{shared_memory}(@{s_how});
	h_this.key = s_key;
	@{s_local} = new @{typed_array}(db_shared.buffer);
@end

@{TypedArrays()}

// const shared_array_buffer = (nt_buffer) => {
// 	let [s_key, db_array] = shm.create(nt_buffer);
// 	console.log('created shared buffer with key: ',s_key);
// 	return Object.assign(db_array.buffer, {
// 		[$_SHAREABLE]: 1,
// 		key: s_key,
// 	});
// };

const ArrayBufferS = (nt_buffer) => shmmap.create(nt_buffer);


// globals
module.exports = {
	exports: {
		ArrayBufferS: ArrayBufferS,
		ArrayBufferT: ArrayBufferS,
		@{memory_exports}
	},
};
