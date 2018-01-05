
const $_SHAREABLE = Symbol('shareable');

function extract(z_data, as_transfers=null) {
	// protect against [object] null
	if(!z_data) return [];

	// set of transfer objects
	if(!as_transfers) as_transfers = new Set();

	// object
	if('object' === typeof z_data) {
		// plain object literal
		if(Object === z_data.constructor) {
			// scan over enumerable properties
			for(let s_property in z_data) {
				// add each transferable from recursion to own set
				extract(z_data[s_property], as_transfers);
			}
		}
		// array
		else if(Array.isArray(z_data)) {
			// scan over each item
			z_data.forEach((z_item) => {
				// add each transferable from recursion to own set
				extract(z_item, as_transfers);
			});
		}
		// typed array, data view or array buffer
		else if(ArrayBuffer.isView(z_data)) {
			as_transfers.add(z_data.buffer);
		}
		// array buffer
		else if(z_data instanceof ArrayBuffer) {
			as_transfers.add(z_data);
		}
		// message port
		else if(z_data instanceof MessagePort) {
			as_transfers.add(z_data);
		}
		// image bitmap
		else if(z_data instanceof ImageBitmap) {
			as_transfers.add(z_data);
		}
	}
	// function
	else if('function' === typeof z_data) {
		// scan over enumerable properties
		for(let s_property in z_data) {
			// add each transferable from recursion to own set
			extract(z_data[s_property], as_transfers);
		}
	}
	// nothing
	else {
		return [];
	}

	// convert set to array
	return Array.from(as_transfers);
}

module.exports = Object.assign(function(z_object) {
	return ArrayBuffer.isView(z_object)
		|| z_object instanceof ArrayBuffer
		|| z_object instanceof MessagePort
		|| z_object instanceof ImageBitmap;
}, {
	$_SHAREABLE,

	extract,
});
