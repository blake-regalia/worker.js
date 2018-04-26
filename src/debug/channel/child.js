const name = process.argv[2];

let d_socket_sibling;

process.on('message', (s_action, d_socket_msg) => {
	// parent is sending a socket
	if('socket' === s_action) {
		console.log(name+' now has a socket');

		// save socket to variable for later use
		d_socket_sibling = d_socket_msg;

		// receive data from sibling
		d_socket_sibling.on('data', (s_data) => {
			console.log(name+' received: '+s_data);
		});
	}
	// otherwise, parent wants me to send message to sibling
	else {
		console.log(name+' is sending: '+s_action);

		// send data to sibling
		d_socket_sibling.write(s_action);
	}
});
