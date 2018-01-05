module.exports = (dz_thing) => {
	Object.assign(dz_thing, {
		events(h_events) {
			for(let s_event in h_events) {
				this['on'+s_event] = h_events[s_event];
			}
		},

		event(s_event, f_event) {
			this['on'+s_event] = f_event;
		},
	});

	return dz_thing;
};
