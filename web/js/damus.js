
let DAMUS

const BOOTSTRAP_RELAYS = [
	"wss://relay.damus.io",
	"wss://nostr-relay.wlvs.space",
	"wss://nostr-pub.wellorder.net"
]

function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

function insert_event_sorted(evs, new_ev) {
        for (let i = 0; i < evs.length; i++) {
                const ev = evs[i]

                if (new_ev.id === ev.id) {
                        return false
                }

                if (new_ev.created_at > ev.created_at) {
                        evs.splice(i, 0, new_ev)
                        return true
                }
        }

        evs.push(new_ev)
        return true
}

function init_contacts() {
	return {
		event: null,
		friends: new Set(),
		friend_of_friends: new Set(),
	}
}

function init_timeline(name) {
	return {
		name,
		events: [],
		rendered: new Set(),
		depths: {},
		expanded: new Set(),
	}
}

function init_home_model() {
	return {
		done_init: {},
		notifications: 0,
		max_depth: 2,
		all_events: {},
		reactions_to: {},
		chatrooms: {},
		deletions: {},
		cw_open: {},
		views: {
			home: init_timeline('home'),
			explore: {
				...init_timeline('explore'),
				seen: new Set(),
			},
			notifications: init_timeline('notifications'),
		},
		pow: 0, // pow difficulty target
		deleted: {},
		profiles: {},
		profile_events: {},
		last_event_of_kind: {},
		contacts: init_contacts()
	}
}

function update_favicon(path)
{
	let link = document.querySelector("link[rel~='icon']");
	const head = document.getElementsByTagName('head')[0]

	if (!link) {
		link = document.createElement('link');
		link.rel = 'icon';
		head.appendChild(link);
	}

	link.href = path;
}

// update_title updates the document title & visual indicators based on if the
// number of notifications that are unseen by the user.
function update_title(model) {
	// TODO rename update_title to update_notification_state or similar
	// TODO only clear notifications once they have seen all targeted events
	if (document.visibilityState === 'visible') {
		model.notifications = 0
	}

	const num = model.notifications
	const has_notes = num !== 0
	document.title = has_notes ? `(${num}) Damus` : "Damus";
	update_favicon(has_notes ? "img/damus_notif.svg" : "img/damus.svg");
	update_notification_markers(has_notes)
}

// update_notification_markers will find all markers and hide or show them
// based on the passed in state of 'active'.
function update_notification_markers(active) {
	let els = document.querySelectorAll(".new-notifications")
	for (const el of els) {
		el.classList.toggle("hide", !active)
	}
}

function notice_chatroom(state, id)
{
	if (!state.chatrooms[id])
		state.chatrooms[id] = {}
}

async function damus_web_init()
{
	init_message_textareas();

	let tries = 0;
	function init() {
		// only wait for 500ms max
		const max_wait = 500
		const interval = 20
		if (window.nostr || tries >= (max_wait/interval)) {
			console.info("init after", tries);
			damus_web_init_ready();
			return;
		}
		tries++;
		setTimeout(init, interval);
	}
	init();
}

async function damus_web_init_ready()
{
	const model = init_home_model()
	DAMUS = model
	model.pubkey = await get_pubkey()
	if (!model.pubkey)
		return
	const {RelayPool} = nostrjs
	const pool = RelayPool(BOOTSTRAP_RELAYS)
	const now = (new Date().getTime()) / 1000

	const ids = {
		comments: "comments",//uuidv4(),
		profiles: "profiles",//uuidv4(),
		explore: "explore",//uuidv4(),
		refevents: "refevents",//uuidv4(),
		account: "account",//uuidv4(),
		home: "home",//uuidv4(),
		contacts: "contacts",//uuidv4(),
		notifications: "notifications",//uuidv4(),
		dms: "dms",//uuidv4(),
	}

	model.pool = pool
	model.view_el = document.querySelector("#view")

	switch_view('home')

	document.addEventListener('visibilitychange', () => {
		update_title(model)
	})

	pool.on('open', (relay) => {
		//let authors = followers
		// TODO: fetch contact list
		log_debug("relay connected", relay.url)

		if (!model.done_init[relay]) {
			send_initial_filters(ids.account, model.pubkey, relay)
		} else {
			send_home_filters(ids, model, relay)
		}
		//relay.subscribe(comments_id, {kinds: [1,42], limit: 100})
	});

	pool.on('event', (relay, sub_id, ev) => {
		handle_home_event(ids, model, relay, sub_id, ev)
	})

	pool.on('notice', (relay, notice) => {
		log_debug("NOTICE", relay, notice)
	})

	pool.on('eose', async (relay, sub_id) => {
		if (sub_id === ids.home) {
			//log_debug("got home EOSE from %s", relay.url)
			const events = model.views.home.events
			handle_comments_loaded(ids, model, events, relay)
		} else if (sub_id === ids.profiles) {
			//log_debug("got profiles EOSE from %s", relay.url)
			const view = get_current_view()
			handle_profiles_loaded(ids, model, view, relay)
		}
	})

	return pool
}

function process_reaction_event(model, ev)
{
	if (!is_valid_reaction_content(ev.content))
		return

	let last = {}

	for (const tag of ev.tags) {
		if (tag.length >= 2 && (tag[0] === "e" || tag[0] === "p"))
			last[tag[0]] = tag[1]
	}

	if (last.e) {
		model.reactions_to[last.e] = model.reactions_to[last.e] || new Set()
		model.reactions_to[last.e].add(ev.id)
	}
}

function process_chatroom_event(model, ev)
{
	try {
		model.chatrooms[ev.id] = JSON.parse(ev.content)
	} catch (err) {
		log_debug("error processing chatroom creation event", ev, err)
	}
}

function process_json_content(ev)
{
	try {
		ev.json_content = JSON.parse(ev.content)
	} catch(e) {
		log_debug("error parsing json content for", ev)
	}
}

function process_deletion_event(model, ev)
{
	for (const tag of ev.tags) {
		if (tag.length >= 2 && tag[0] === "e") {
			const evid = tag[1]

			// we've already recorded this one as a valid deleted event
			// we can just ignore it
			if (model.deleted[evid])
				continue

			let ds = model.deletions[evid] = (model.deletions[evid] || new Set())

			// add the deletion event id to the deletion set of this event
			// we will use this to determine if this event is valid later in
			// case we don't have the deleted event yet.
			ds.add(ev.id)
		}
	}
}

function is_deleted(model, evid)
{
	// we've already know it's deleted
	if (model.deleted[evid])
		return model.deleted[evid]

	const ev = model.all_events[evid]
	if (!ev)
		return false

	// all deletion events
	const ds = model.deletions[ev.id]
	if (!ds)
		return false

	// find valid deletion events
	for (const id of ds.keys()) {
		const d_ev = model.all_events[id]
		if (!d_ev)
			continue

		// only allow deletes from the user who created it
		if (d_ev.pubkey === ev.pubkey) {
			model.deleted[ev.id] = d_ev
			log_debug("received deletion for", ev)
			// clean up deletion data that we don't need anymore
			delete model.deletions[ev.id]
			return true
		} else {
			log_debug(`User ${d_ev.pubkey} tried to delete ${ev.pubkey}'s event ... what?`)
		}
	}

	return false
}

function process_event(model, ev)
{
	ev.refs = determine_event_refs(ev.tags)
	const notified = was_pubkey_notified(model.pubkey, ev)
	ev.notified = notified

	ev.pow = calculate_pow(ev)

	if (ev.kind === 7)
		process_reaction_event(model, ev)
	else if (ev.kind === 42 && ev.refs && ev.refs.root)
		notice_chatroom(model, ev.refs.root)
	else if (ev.kind === 40)
		process_chatroom_event(model, ev)
	else if (ev.kind === 6)
		process_json_content(ev)
	else if (ev.kind === 5)
		process_deletion_event(model, ev)
	else if (ev.kind === 0)
		process_profile_event(model, ev)
	else if (ev.kind === 3)
		process_contact_event(model, ev)

	const last_notified = get_local_state('last_notified_date')
	if (notified && (last_notified == null || ((ev.created_at*1000) > last_notified))) {
		set_local_state('last_notified_date', new Date().getTime())
		model.notifications++
		update_title(model)
	}
}

function was_pubkey_notified(pubkey, ev)
{
	if (!(ev.kind === 1 || ev.kind === 42))
		return false

	if (ev.pubkey === pubkey)
		return false

	for (const tag of ev.tags) {
		if (tag.length >= 2 && tag[0] === "p" && tag[1] === pubkey)
			return true
	}

	return false
}

function should_add_to_timeline(ev)
{
	return ev.kind === 1 || ev.kind === 42 || ev.kind === 6
}

function should_add_to_notification_timeline(our_pk, contacts, ev, pow)
{
	if (!should_add_to_timeline(ev))
		return false

	if (our_pk === ev.pubkey)
		return false

	if (our_pk !== ev.pubkey && contacts.friends.has(ev.pubkey))
		return true

	// TODO: add items that don't pass spam filter to "message requests"
	// Then we will need a way to whitelist people as an alternative to
	// following them
	return passes_spam_filter(contacts, ev, pow)
}

function should_add_to_explore_timeline(contacts, view, ev, pow)
{
	if (!should_add_to_timeline(ev))
		return false

	if (view.seen.has(ev.pubkey))
		return false

	// hide friends for 0-pow situations
	if (pow === 0 && contacts.friends.has(ev.pubkey))
		return false

	return passes_spam_filter(contacts, ev, pow)
}

function get_current_view()
{
	// TODO resolve memory & html descriptencies
	// Currently there is tracking of which divs are visible in HTML/CSS and
	// which is active in memory, simply resolve this by finding the visible
	// element instead of tracking it in memory (or remove dom elements). This
	// would simplify state tracking IMO - Thomas
	return DAMUS.views[DAMUS.current_view]
}

function handle_redraw_logic(model, view_name)
{
	if (get_current_view().name === view_name) {
		const view = model.views[view_name]
		if (view.redraw_timer)
			clearTimeout(view.redraw_timer)
		view.redraw_timer = setTimeout(redraw_events.bind(null, model, view), 500)
	}
}

function handle_home_event(ids, model, relay, sub_id, ev) {
	// ignore duplicates
	if (!model.all_events[ev.id]) {
		model.all_events[ev.id] = ev
		process_event(model, ev)
	}

	ev = model.all_events[ev.id]

	let is_new = true
	switch (sub_id) {
	case ids.explore:
		const view = model.views.explore

		// show more things in explore timeline
		if (should_add_to_explore_timeline(model.contacts, view, ev, model.pow)) {
			view.seen.add(ev.pubkey)
			is_new = insert_event_sorted(view.events, ev)
		}

		if (is_new)
			handle_redraw_logic(model, 'explore')
		break;

	case ids.notifications:
		if (should_add_to_notification_timeline(model.pubkey, model.contacts, ev, model.pow))
			is_new = insert_event_sorted(model.views.notifications.events, ev)

		if (is_new)
			handle_redraw_logic(model, 'notifications')
		break;

	case ids.home:
		if (should_add_to_timeline(ev))
			is_new = insert_event_sorted(model.views.home.events, ev)

		if (is_new)
			handle_redraw_logic(model, 'home')
		break;
	case ids.account:
		switch (ev.kind) {
		case 3:
			model.done_init[relay] = true
			model.pool.unsubscribe(ids.account, relay)
			send_home_filters(ids, model, relay)
			break
		}
	case ids.profiles:
		break
	}
}

function process_profile_event(model, ev) {
	const prev_ev = model.profile_events[ev.pubkey]
	if (prev_ev && prev_ev.created_at > ev.created_at)
		return

	model.profile_events[ev.pubkey] = ev
	try {
		model.profiles[ev.pubkey] = JSON.parse(ev.content)
	} catch(e) {
		log_debug("failed to parse profile contents", ev)
	}
}

function send_initial_filters(account_id, pubkey, relay) {
	const filter = {authors: [pubkey], kinds: [3], limit: 1}
	//console.log("sending initial filter", filter)
	relay.subscribe(account_id, filter)
}

function send_home_filters(ids, model, relay) {
	const friends = contacts_friend_list(model.contacts)
	friends.push(model.pubkey)


	const contacts_filter = {kinds: [0], authors: friends}
	const dms_filter = {kinds: [4], limit: 100}
	const our_dms_filter = {kinds: [4], authors: [ model.pubkey ], limit: 100}

	const standard_kinds = [1,42,5,6,7]

	const home_filter = {kinds: standard_kinds, authors: friends, limit: 500}

	// TODO: include pow+fof spam filtering in notifications query
	const notifications_filter = {kinds: standard_kinds, "#p": [model.pubkey], limit: 100}

	let home_filters = [home_filter]
	let notifications_filters = [notifications_filter]
	let contacts_filters = [contacts_filter]
	let dms_filters = [dms_filter, our_dms_filter]

	let last_of_kind = {}
	if (relay) {
		last_of_kind =
			model.last_event_of_kind[relay] =
			model.last_event_of_kind[relay] || {}
	}

        update_filters_with_since(last_of_kind, home_filters)
        update_filters_with_since(last_of_kind, contacts_filters)
        update_filters_with_since(last_of_kind, notifications_filters)
        update_filters_with_since(last_of_kind, dms_filters)

	const subto = relay? [relay] : undefined
	model.pool.subscribe(ids.home, home_filters, subto)
	model.pool.subscribe(ids.contacts, contacts_filters, subto)
	model.pool.subscribe(ids.notifications, notifications_filters, subto)
	model.pool.subscribe(ids.dms, dms_filters, subto)
}

function get_since_time(last_event) {
	if (!last_event) {
		return null
	}

	return last_event.created_at - 60 * 10
}

function update_filter_with_since(last_of_kind, filter) {
	const kinds = filter.kinds || []
	let initial = null
	let earliest = kinds.reduce((earliest, kind) => {
		const last = last_of_kind[kind]
		let since = get_since_time(last)

		if (!earliest) {
			if (since === null)
				return null

			return since
		}

		if (since === null)
			return earliest

		return since < earliest ? since : earliest

	}, initial)

	if (earliest)
		filter.since = earliest
}

function update_filters_with_since(last_of_kind, filters) {
	for (const filter of filters) {
		update_filter_with_since(last_of_kind, filter)
	}
}

function contacts_friend_list(contacts) {
	return Array.from(contacts.friends)
}

function contacts_friendosphere(contacts) {
	let s = new Set()
	let fs = []

	for (const friend of contacts.friends.keys()) {
		fs.push(friend)
		s.add(friend)
	}

	for (const friend of contacts.friend_of_friends.keys()) {
		if (!s.has(friend))
			fs.push(friend)
	}

	return fs
}

function process_contact_event(model, ev) {
	load_our_contacts(model.contacts, model.pubkey, ev)
	load_our_relays(model.pubkey, model.pool, ev)
	add_contact_if_friend(model.contacts, ev)
}

function add_contact_if_friend(contacts, ev) {
	if (!contact_is_friend(contacts, ev.pubkey))
		return

	add_friend_contact(contacts, ev)
}

function contact_is_friend(contacts, pk) {
	return contacts.friends.has(pk)
}

function add_friend_contact(contacts, contact) {
	contacts.friends.add(contact.pubkey)

	for (const tag of contact.tags) {
		if (tag.length >= 2 && tag[0] == "p") {
			if (!contact_is_friend(contacts, tag[1]))
				contacts.friend_of_friends.add(tag[1])
		}
	}
}

function get_view_el(name)
{
	return DAMUS.view_el.querySelector(`#${name}-view`)
}

function switch_view(name, opts={})
{
	if (name === DAMUS.current_view) {
		log_debug("Not switching to '%s', we are already there", name)
		return
	}

	const last = get_current_view()
	if (!last) {
		// render initial
		DAMUS.current_view = name
		redraw_timeline_events(DAMUS, name)
		return
	}

	log_debug("switching to '%s' by hiding '%s'", name, DAMUS.current_view)

	DAMUS.current_view = name
	const current = get_current_view()
	const last_el = get_view_el(last.name)
	const current_el = get_view_el(current.name)

	if (last_el)
		last_el.classList.add("hide");

	// TODO accomodate views that do not render events
	// TODO find out if having multiple event divs is slow
	redraw_timeline_events(DAMUS, name)

	if (current_el)
		current_el.classList.remove("hide");
}

function load_our_relays(our_pubkey, pool, ev) {
	if (ev.pubkey != our_pubkey)
		return

	let relays
	try {
		relays = JSON.parse(ev.content)
	} catch (e) {
		log_debug("error loading relays", e)
		return
	}

	for (const relay of Object.keys(relays)) {
		log_debug("adding relay", relay)
		if (!pool.has(relay))
			pool.add(relay)
	}
}

function log_error(fmt, ...args) {
	console.log("[ERROR] " + fmt, ...args)
}

function log_debug(fmt, ...args) {
	console.log("[debug] " + fmt, ...args)
}

function load_our_contacts(contacts, our_pubkey, ev) {
	if (ev.pubkey !== our_pubkey)
		return

	contacts.event = ev

	for (const tag of ev.tags) {
		if (tag.length > 1 && tag[0] === "p") {
			contacts.friends.add(tag[1])
		}
	}
}

function get_referenced_events(model, events)
{
	let evset = new Set()
	for (const ev of events) {
		for (const tag of ev.tags) {
			if (tag.length >= 2 && tag[0] === "e") {
				const e = tag[1]
				if (!model.all_events[e]) {
					evset.add(e)
				}
			}
		}
	}
	return Array.from(evset)
}


function fetch_referenced_events(refevents_id, model, relay) {

	const ref = df
	model.pool.subscribe(refevents_id, [filter], relay)
}

function zero_bits(b)
{
        let n = 0;

        if (b == 0)
                return 8;

        while (b >>= 1)
                n++;

        return 7-n;
}

function leading_zero_bits(id)
{
	const buf = nostrjs.hex_decode(id)

	let i
	for (i = 0, total = 0; i < 32; i++) {
		bits = zero_bits(buf[i])
		total += bits
		if (bits != 8)
			break
	}

	return total
}

function min(a, b) {
	return a < b ? a : b;
}

function difficulty_to_prefix(d)
{
	const n = Math.floor(d / 4)
	let s = ""
	for (i = 0; i < n; i++) {
		s += "0"
	}
	return s
}

function calculate_pow(ev)
{
	const id_bits = leading_zero_bits(ev.id)
	for (const tag of ev.tags) {
		if (tag.length >= 3 && tag[0] === "nonce") {
			const target = +tag[2]
			if (isNaN(target))
				return 0

			// if our nonce target is smaller than the difficulty,
			// then we use the nonce target as the actual difficulty
			return min(target, id_bits)
		}
	}

	// not a valid pow if we don't have a difficulty target
	return 0
}

function handle_profiles_loaded(ids, model, view, relay) {
	// stop asking for profiles
	model.pool.unsubscribe(ids.profiles, relay)
	redraw_events(model, view)
	redraw_my_pfp(model)

	const prefix = difficulty_to_prefix(model.pow)
	const fofs = Array.from(model.contacts.friend_of_friends)
	const standard_kinds = [1,42,5,6,7]
	let pow_filter = {kinds: standard_kinds, limit: 200}
	if (model.pow > 0)
		pow_filter.ids = [ prefix ]

	let explore_filters = [ pow_filter ]

	if (fofs.length > 0) {
		explore_filters.push({kinds: standard_kinds, authors: fofs, limit: 200})
	}

	model.pool.subscribe(ids.explore, explore_filters, relay)
}

function redraw_my_pfp(model) {
	const html = render_pfp(model.pubkey, model.profiles[model.pubkey]);
	document.querySelector(".my-userpic").innerHTML = html;
}

function debounce(f, interval) {
	let timer = null;
	let first = true;

	return (...args) => {
		clearTimeout(timer);
		return new Promise((resolve) => {
			timer = setTimeout(() => resolve(f(...args)), first? 0 : interval);
			first = false
		});
	};
}

function get_unknown_chatroom_ids(state)
{
	let chatroom_ids = []
	for (const key of Object.keys(state.chatrooms)) {
		const chatroom = state.chatrooms[key]
		if (chatroom.name === undefined)
			chatroom_ids.push(key)
	}
	return chatroom_ids
}

// load profiles after comment notes are loaded
function handle_comments_loaded(ids, model, events, relay)
{
	const pubkeys = events.reduce((s, ev) => {
		s.add(ev.pubkey)
		for (const tag of ev.tags) {
			if (tag.length >= 2 && tag[0] === "p") {
				if (!model.profile_events[tag[1]])
					s.add(tag[1])
			}
		}
		return s
	}, new Set())
	const authors = Array.from(pubkeys)

	// load profiles and noticed chatrooms
	const chatroom_ids = get_unknown_chatroom_ids(model)
	const profile_filter = {kinds: [0,3], authors: authors}
	const chatroom_filter = {kinds: [40], ids: chatroom_ids}

	let filters = []

	if (authors.length > 0)
		filters.push(profile_filter)

	if (chatroom_ids.length > 0)
		filters.push(chatroom_filter)

	const ref_evids = get_referenced_events(model, events)
	if (ref_evids.length > 0) {
		log_debug("got %d new referenced events to pull from %s after initial load", ref_evids.length, relay.url)
		filters.push({ids: ref_evids})
		filters.push({"#e": ref_evids})
	}

	if (filters.length === 0) {
		log_debug("No profiles filters to request...")
		return
	}

	//console.log("subscribe", profiles_id, filter, relay)
	log_debug("subscribing to profiles on %s", relay.url)
	model.pool.subscribe(ids.profiles, filters, relay)
}

function redraw_events(damus, view) {
	//log_debug("redrawing events for", view)
	view.rendered = new Set()

	const events_el = damus.view_el.querySelector(`#${view.name}-view > .events`)
	events_el.innerHTML = render_events(damus, view)

	setup_timeline_event_handlers(events_el)
}

function setup_timeline_event_handlers(events_el)
{
	// TODO use ontoggle instead for cw?
	// TODO check if CW state needs to be stored in memory
	// Is there a way we can just use the HTML/CSS state instead does it matter
	// if we have them closed by default. I think this is only a problem
	// because we draw the entire timeline.
	for (const el of events_el.querySelectorAll(".cw"))
		el.addEventListener("toggle", toggle_content_warning.bind(null))
}

function redraw_timeline_events(damus, name) {
	const view = DAMUS.views[name]
	const events_el = damus.view_el.querySelector(`#${name}-view > .events`)

	if (view.events.length > 0) {
		redraw_events(damus, view)
	} else {
		events_el.innerHTML = render_loading_spinner()
	}
}

async function send_post() {
	const input_el = document.querySelector("#post-input")
	const cw_el = document.querySelector("#content-warning-input")

	const cw = cw_el.value
	const content = input_el.value
	const created_at = Math.floor(new Date().getTime() / 1000)
	const kind = 1
	const tags = cw ? [["content-warning", cw]] : []
	const pubkey = await get_pubkey()
	const {pool} = DAMUS

	let post = { pubkey, tags, content, created_at, kind }

	post.id = await nostrjs.calculate_id(post)
	post = await sign_event(post)

	pool.send(["EVENT", post])

	input_el.value = ""
	cw_el.value = ""
	post_input_changed(input_el)
}

async function sign_event(ev) {
	if (window.nostr && window.nostr.signEvent) {
		const signed = await window.nostr.signEvent(ev)
		if (typeof signed === 'string') {
			ev.sig = signed
			return ev
		}
		return signed
	}

	const privkey = get_privkey()
	ev.sig = await sign_id(privkey, ev.id)
	return ev
}

function determine_event_refs_positionally(pubkeys, ids)
{
	if (ids.length === 1)
		return {root: ids[0], reply: ids[0], pubkeys}
	else if (ids.length >= 2)
		return {root: ids[0], reply: ids[1], pubkeys}

	return {pubkeys}
}

function determine_event_refs(tags) {
	let positional_ids = []
	let pubkeys = []
	let root
	let reply
	let i = 0

	for (const tag of tags) {
		if (tag.length >= 4 && tag[0] == "e") {
			positional_ids.push(tag[1])
			if (tag[3] === "root") {
				root = tag[1]
			} else if (tag[3] === "reply") {
				reply = tag[1]
			}
		} else if (tag.length >= 2 && tag[0] == "e") {
			positional_ids.push(tag[1])
		} else if (tag.length >= 2 && tag[0] == "p") {
			pubkeys.push(tag[1])
		}

		i++
	}

	if (!(root && reply) && positional_ids.length > 0)
		return determine_event_refs_positionally(pubkeys, positional_ids)

	/*
	if (reply && !root)
		root = reply
		*/

	return {root, reply, pubkeys}
}

function can_reply(ev) {
	return ev.kind === 1 || ev.kind === 42
}

const DEFAULT_PROFILE = {
	name: "anon",
	display_name: "Anonymous",
}

function* yield_etags(tags)
{
	for (const tag of tags) {
		if (tag.length >= 2 && tag[0] === "e")
			yield tag
	}
}

function expand_thread(id) {
	const view = get_current_view()
	const root_id = get_thread_root_id(DAMUS, id)
	if (!root_id) {
		log_debug("could not get root_id for", DAMUS.all_events[id])
		return
	}

	view.depths[root_id] = get_thread_max_depth(DAMUS, view, root_id) + 1

	redraw_events(DAMUS, view)
}

function get_thread_root_id(damus, id)
{
	const ev = damus.all_events[id]
	if (!ev) {
		log_debug("expand_thread: no event found?", id)
		return null
	}

	return ev.refs && ev.refs.root
}

function get_thread_max_depth(damus, view, root_id)
{
	if (!view.depths[root_id])
		return damus.max_depth

	return view.depths[root_id]
}

function delete_post_confirm(evid) {
	if (!confirm("Are you sure you want to delete this post?"))
		return

	const reason = (prompt("Why you are deleting this? Leave empty to not specify. Type CANCEL to cancel.") || "").trim()

	if (reason.toLowerCase() === "cancel")
		return

	delete_post(evid, reason)
}

function shouldnt_render_event(our_pk, view, ev, opts) {
	return !opts.is_boost_event && !opts.is_composing && view.rendered.has(ev.id)
}

function press_logout() {
	if (confirm("Are you sure you want to sign out?")) {
		localStorage.clear();
		const url = new URL(location.href)
		url.searchParams.delete("pk")
		window.location.href = url.toString()
	}
}

const REACTION_REGEX = /^[#*0-9]\uFE0F?\u20E3|[\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23ED-\u23EF\u23F1\u23F2\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB\u25FC\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692\u2694-\u2697\u2699\u269B\u269C\u26A0\u26A7\u26AA\u26B0\u26B1\u26BD\u26BE\u26C4\u26C8\u26CF\u26D1\u26D3\u26E9\u26F0-\u26F5\u26F7\u26F8\u26FA\u2702\u2708\u2709\u270F\u2712\u2714\u2716\u271D\u2721\u2733\u2734\u2744\u2747\u2757\u2763\u27A1\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B55\u3030\u303D\u3297\u3299]\uFE0F?|[\u261D\u270C\u270D](?:\uFE0F|\uD83C[\uDFFB-\uDFFF])?|[\u270A\u270B](?:\uD83C[\uDFFB-\uDFFF])?|[\u23E9-\u23EC\u23F0\u23F3\u25FD\u2693\u26A1\u26AB\u26C5\u26CE\u26D4\u26EA\u26FD\u2705\u2728\u274C\u274E\u2753-\u2755\u2795-\u2797\u27B0\u27BF\u2B50]|\u26F9(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|\u2764\uFE0F?(?:\u200D(?:\uD83D\uDD25|\uD83E\uDE79))?|\uD83C(?:[\uDC04\uDD70\uDD71\uDD7E\uDD7F\uDE02\uDE37\uDF21\uDF24-\uDF2C\uDF36\uDF7D\uDF96\uDF97\uDF99-\uDF9B\uDF9E\uDF9F\uDFCD\uDFCE\uDFD4-\uDFDF\uDFF5\uDFF7]\uFE0F?|[\uDF85\uDFC2\uDFC7](?:\uD83C[\uDFFB-\uDFFF])?|[\uDFC3\uDFC4\uDFCA](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDFCB\uDFCC](?:\uFE0F|\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDCCF\uDD8E\uDD91-\uDD9A\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF84\uDF86-\uDF93\uDFA0-\uDFC1\uDFC5\uDFC6\uDFC8\uDFC9\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF8-\uDFFF]|\uDDE6\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF]|\uDDE7\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF]|\uDDE8\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF5\uDDF7\uDDFA-\uDDFF]|\uDDE9\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF]|\uDDEA\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA]|\uDDEB\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7]|\uDDEC\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE]|\uDDED\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA]|\uDDEE\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9]|\uDDEF\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5]|\uDDF0\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF]|\uDDF1\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE]|\uDDF2\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF]|\uDDF3\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF]|\uDDF4\uD83C\uDDF2|\uDDF5\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE]|\uDDF6\uD83C\uDDE6|\uDDF7\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC]|\uDDF8\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF]|\uDDF9\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF]|\uDDFA\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF]|\uDDFB\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA]|\uDDFC\uD83C[\uDDEB\uDDF8]|\uDDFD\uD83C\uDDF0|\uDDFE\uD83C[\uDDEA\uDDF9]|\uDDFF\uD83C[\uDDE6\uDDF2\uDDFC]|\uDFF3\uFE0F?(?:\u200D(?:\u26A7\uFE0F?|\uD83C\uDF08))?|\uDFF4(?:\u200D\u2620\uFE0F?|\uDB40\uDC67\uDB40\uDC62\uDB40(?:\uDC65\uDB40\uDC6E\uDB40\uDC67|\uDC73\uDB40\uDC63\uDB40\uDC74|\uDC77\uDB40\uDC6C\uDB40\uDC73)\uDB40\uDC7F)?)|\uD83D(?:[\uDC08\uDC26](?:\u200D\u2B1B)?|[\uDC3F\uDCFD\uDD49\uDD4A\uDD6F\uDD70\uDD73\uDD76-\uDD79\uDD87\uDD8A-\uDD8D\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA\uDECB\uDECD-\uDECF\uDEE0-\uDEE5\uDEE9\uDEF0\uDEF3]\uFE0F?|[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC](?:\uD83C[\uDFFB-\uDFFF])?|[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDD74\uDD90](?:\uFE0F|\uD83C[\uDFFB-\uDFFF])?|[\uDC00-\uDC07\uDC09-\uDC14\uDC16-\uDC25\uDC27-\uDC3A\uDC3C-\uDC3E\uDC40\uDC44\uDC45\uDC51-\uDC65\uDC6A\uDC79-\uDC7B\uDC7D-\uDC80\uDC84\uDC88-\uDC8E\uDC90\uDC92-\uDCA9\uDCAB-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDDA4\uDDFB-\uDE2D\uDE2F-\uDE34\uDE37-\uDE44\uDE48-\uDE4A\uDE80-\uDEA2\uDEA4-\uDEB3\uDEB7-\uDEBF\uDEC1-\uDEC5\uDED0-\uDED2\uDED5-\uDED7\uDEDC-\uDEDF\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB\uDFF0]|\uDC15(?:\u200D\uD83E\uDDBA)?|\uDC3B(?:\u200D\u2744\uFE0F?)?|\uDC41\uFE0F?(?:\u200D\uD83D\uDDE8\uFE0F?)?|\uDC68(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDC68\uDC69]\u200D\uD83D(?:\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?)|[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?)|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFC-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFD-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFD\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFE])))?))?|\uDC69(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?[\uDC68\uDC69]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?|\uDC69\u200D\uD83D(?:\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?))|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFC-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB\uDFFD-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB-\uDFFD\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB-\uDFFE])))?))?|\uDC6F(?:\u200D[\u2640\u2642]\uFE0F?)?|\uDD75(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|\uDE2E(?:\u200D\uD83D\uDCA8)?|\uDE35(?:\u200D\uD83D\uDCAB)?|\uDE36(?:\u200D\uD83C\uDF2B\uFE0F?)?)|\uD83E(?:[\uDD0C\uDD0F\uDD18-\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5\uDEC3-\uDEC5\uDEF0\uDEF2-\uDEF8](?:\uD83C[\uDFFB-\uDFFF])?|[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDDDE\uDDDF](?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDD0D\uDD0E\uDD10-\uDD17\uDD20-\uDD25\uDD27-\uDD2F\uDD3A\uDD3F-\uDD45\uDD47-\uDD76\uDD78-\uDDB4\uDDB7\uDDBA\uDDBC-\uDDCC\uDDD0\uDDE0-\uDDFF\uDE70-\uDE7C\uDE80-\uDE88\uDE90-\uDEBD\uDEBF-\uDEC2\uDECE-\uDEDB\uDEE0-\uDEE8]|\uDD3C(?:\u200D[\u2640\u2642]\uFE0F?|\uD83C[\uDFFB-\uDFFF])?|\uDDD1(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83E\uDDD1))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFC-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB\uDFFD-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB-\uDFFD\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB-\uDFFE]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF-\uDDB3\uDDBC\uDDBD]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF])))?))?|\uDEF1(?:\uD83C(?:\uDFFB(?:\u200D\uD83E\uDEF2\uD83C[\uDFFC-\uDFFF])?|\uDFFC(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB\uDFFD-\uDFFF])?|\uDFFD(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])?|\uDFFE(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB-\uDFFD\uDFFF])?|\uDFFF(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB-\uDFFE])?))?)$/

const WORD_REGEX=/\w/
function is_emoji(str)
{
	return !WORD_REGEX.test(str) && REACTION_REGEX.test(str)
}

function is_valid_reaction_content(content)
{
	return content === "+" || content === "" || is_emoji(content)
}

function get_reaction_emoji(ev) {
	if (ev.content === "+" || ev.content === "")
		return "❤️"

	return ev.content
}

async function delete_post(id, reason)
{
	const ev = DAMUS.all_events[id]
	if (!ev)
		return

	const pubkey = await get_pubkey()
	let del = await create_deletion_event(pubkey, id, reason)
	console.log("deleting", ev)
	broadcast_event(del)
}

function get_reactions(model, evid)
{
	const reactions_set = model.reactions_to[evid]
	if (!reactions_set)
		return ""

	let reactions = []
	for (const id of reactions_set.keys()) {
		if (is_deleted(model, id))
			continue
		const reaction = model.all_events[id]
		if (!reaction)
			continue
		reactions.push(reaction)
	}

	const groups = reactions.reduce((grp, r) => {
		const e = get_reaction_emoji(r)
		grp[e] = grp[e] || {}
		grp[e][r.pubkey] = r
		return grp
	}, {})

	return groups
}

function close_reply() {
	const modal = document.querySelector("#reply-modal")
	modal.classList.add("closed");
}

function gather_reply_tags(pubkey, from) {
	let tags = []
	for (const tag of from.tags) {
		if (tag.length >= 2) {
			if (tag[0] === "e") {
				if (tag.length >= 4 && tag[3] == "root")
					tags.push(tag)
				else
					tags.push(["e", tag[1]])
			} else if (tag[0] === "p" && tag[1] !== pubkey) {
				tags.push(["p", tag[1]])
			}
		}
	}
	tags.push(["e", from.id, "", "reply"])
	if (from.pubkey !== pubkey)
		tags.push(["p", from.pubkey])
	return tags
}

async function create_deletion_event(pubkey, target, content="")
{
	const created_at = Math.floor(new Date().getTime() / 1000)
	let kind = 5

	const tags = [["e", target]]
	let del = { pubkey, tags, content, created_at, kind }

	del.id = await nostrjs.calculate_id(del)
	del = await sign_event(del)
	return del
}

async function create_reply(pubkey, content, from) {
	const tags = gather_reply_tags(pubkey, from)
	const created_at = Math.floor(new Date().getTime() / 1000)
	let kind = from.kind

	// convert emoji replies into reactions
	if (is_valid_reaction_content(content))
		kind = 7

	let reply = { pubkey, tags, content, created_at, kind }

	reply.id = await nostrjs.calculate_id(reply)
	reply = await sign_event(reply)
	return reply
}

function get_tag_event(tag)
{
	if (tag.length < 2)
		return null

	if (tag[0] === "e")
		return DAMUS.all_events[tag[1]]

	if (tag[0] === "p")
		return DAMUS.profile_events[tag[1]]

	return null
}

async function broadcast_related_events(ev)
{
	ev.tags
		.reduce((evs, tag) => {
			// cap it at something sane
			if (evs.length >= 5)
				return evs
			const ev = get_tag_event(tag)
			if (!ev)
				return evs
			insert_event_sorted(evs, ev) // for uniqueness
			return evs
		}, [])
		.forEach((ev, i) => {
			// so we don't get rate limited
			setTimeout(() => {
				log_debug("broadcasting related event", ev)
				broadcast_event(ev)
			}, (i+1)*1200)
		})
}

function broadcast_event(ev) {
	DAMUS.pool.send(["EVENT", ev])
}

async function send_reply(content, replying_to)
{
	const ev = DAMUS.all_events[replying_to]
	if (!ev)
		return

	const pubkey = await get_pubkey()
	let reply = await create_reply(pubkey, content, ev)

	broadcast_event(reply)
	broadcast_related_events(reply)
}

async function do_send_reply() {
	const modal = document.querySelector("#reply-modal")
	const replying_to = modal.querySelector("#replying-to")

	const evid = replying_to.dataset.evid
	const reply_content_el = document.querySelector("#reply-content")
	const content = reply_content_el.value

	await send_reply(content, evid)

	reply_content_el.value = ""

	close_reply()
}

function bech32_decode(pubkey) {
	const decoded = bech32.decode(pubkey)
	const bytes = fromWords(decoded.words)
	return nostrjs.hex_encode(bytes)
}

function get_local_state(key) {
	if (DAMUS[key] != null)
		return DAMUS[key]

	return localStorage.getItem(key)
}

function set_local_state(key, val) {
	DAMUS[key] = val
	localStorage.setItem(key, val)
}

function get_qs(loc=location.href) {
	return new URL(loc).searchParams
}

async function get_nip05_pubkey(email) {
	const [user, host] = email.split("@")
	const url = `https://${host}/.well-known/nostr.json?name=${user}`

	try {
		const res = await fetch(url)
		const json = await res.json()

		log_debug("nip05 data", json)
		return json.names[user]
	} catch (e) {
		log_error("fetching nip05 entry for %s", email, e)
		throw e
	}
}

async function handle_pubkey(pubkey) {
	if (pubkey[0] === "n")
		pubkey = bech32_decode(pubkey)

	if (pubkey.includes("@"))
		pubkey = await get_nip05_pubkey(pubkey)

	set_local_state('pubkey', pubkey)

	return pubkey
}

async function get_pubkey() {
	let pubkey = get_local_state('pubkey')

	// qs pk overrides stored key
	const qs_pk = get_qs().get("pk")
	if (qs_pk)
		return await handle_pubkey(qs_pk)

	if (pubkey)
		return pubkey

	console.log("window.nostr", window.nostr)
	if (window.nostr && window.nostr.getPublicKey) {
		console.log("calling window.nostr.getPublicKey()...")
		const pubkey = await window.nostr.getPublicKey()
		console.log("got %s pubkey from nos2x", pubkey)
		return await handle_pubkey(pubkey)
	}

	pubkey = prompt("Enter nostr id (eg: jb55@jb55.com) or pubkey (hex or npub)")

	if (!pubkey)
		throw new Error("Need pubkey to continue")

	return await handle_pubkey(pubkey)
}

function get_privkey() {
	let privkey = get_local_state('privkey')

	if (privkey)
		return privkey

	if (!privkey)
		privkey = prompt("Enter private key")

	if (!privkey)
		throw new Error("can't get privkey")

	if (privkey[0] === "n") {
		privkey = bech32_decode(privkey)
	}

	set_local_state('privkey', privkey)

	return privkey
}

async function sign_id(privkey, id)
{
	//const digest = nostrjs.hex_decode(id)
	const sig = await nobleSecp256k1.schnorr.sign(id, privkey)
	return nostrjs.hex_encode(sig)
}

function reply_to(evid) {
	const modal = document.querySelector("#reply-modal")
	const replybox = modal.querySelector("#reply-content")
	modal.classList.remove("closed")
	const replying_to = modal.querySelector("#replying-to")

	replying_to.dataset.evid = evid

	const ev = DAMUS.all_events[evid]
	const view = get_current_view()
	replying_to.innerHTML = render_event(DAMUS, view, ev, {is_composing: true, nobar: true, max_depth: 1})

	replybox.focus()
}

const IMG_REGEX = /(png|jpeg|jpg|gif|webp)$/i
function is_img_url(path) {
	return IMG_REGEX.test(path)
}

const VID_REGEX = /(webm|mp4)$/i
function is_video_url(path) {
	return VID_REGEX.test(path)
}

const URL_REGEX = /(^|\s)(https?:\/\/[^\s]+)[,:)]?(\w|$)/g;
function linkify(text, show_media) {
	return text.replace(URL_REGEX, function(match, p1, p2, p3) {
		const url = p2+p3
		const parsed = new URL(url)
		let html;
		if (show_media && is_img_url(parsed.pathname)) {
			html = `
			<a target="_blank" href="${url}">
				<img class="inline-img" src="${url}"/>
			</a>
			`;
		} else if (show_media && is_video_url(parsed.pathname)) {
			html = `
			<video controls class="inline-img" />
			  <source src="${url}">
			</video>
			`;
		} else {
			html = `<a target="_blank" rel="noopener noreferrer" href="${url}">${url}</a>`;
		}
		return p1+html;
	})
}

function convert_quote_blocks(content, show_media)
{
	const split = content.split("\n")
	let blockin = false
	return split.reduce((str, line) => {
		if (line !== "" && line[0] === '>') {
			if (!blockin) {
				str += "<span class='quote'>"
				blockin = true
			}
			str += linkify(sanitize(line.slice(1)), show_media)
		} else {
			if (blockin) {
				blockin = false
				str += "</span>"
			}
			str += linkify(sanitize(line), show_media)
		}
		return str + "<br/>"
	}, "")
}

function get_content_warning(tags)
{
	for (const tag of tags) {
		if (tag.length >= 1 && tag[0] === "content-warning")
			return tag[1] || ""
	}

	return null
}

function toggle_content_warning(e)
{
	const el = e.target
	const id = el.id.split("_")[1]
	const ev = DAMUS.all_events[id]

	if (!ev) {
		log_debug("could not find content-warning event", id)
		return
	}

	DAMUS.cw_open[id] = el.open
}

function format_content(ev, show_media)
{
	if (ev.kind === 7) {
		if (ev.content === "" || ev.content === "+")
			return "❤️"
		return sanitize(ev.content.trim())
	}

	const content = ev.content.trim()
	const body = convert_quote_blocks(content, show_media)

	let cw = get_content_warning(ev.tags)
	if (cw !== null) {
		let cwHTML = "Content Warning"
		if (cw === "") {
			cwHTML += "."
		} else {
			cwHTML += `: "<span>${cw}</span>".`
		}
		const open = !!DAMUS.cw_open[ev.id]? "open" : ""
		return `
		<details class="cw" id="cw_${ev.id}" ${open}>
		  <summary class="event-message">${cwHTML}</summary>
		  ${body}
		</details>
		`
	}

	return body
}

function sanitize(content)
{
	if (!content)
		return ""
	return content.replaceAll("<","&lt;").replaceAll(">","&gt;")
}

function robohash(pk) {
	return "https://robohash.org/" + pk
}

function get_picture(pk, profile) {
	if (!profile)
		return robohash(pk)
	if (profile.resolved_picture)
		return profile.resolved_picture
	profile.resolved_picture = sanitize(profile.picture) || robohash(pk)
	return profile.resolved_picture
}

function time_delta(current, previous) {
    var msPerMinute = 60 * 1000;
    var msPerHour = msPerMinute * 60;
    var msPerDay = msPerHour * 24;
    var msPerMonth = msPerDay * 30;
    var msPerYear = msPerDay * 365;

    var elapsed = current - previous;

    if (elapsed < msPerMinute) {
         return Math.round(elapsed/1000) + ' seconds ago';
    }

    else if (elapsed < msPerHour) {
         return Math.round(elapsed/msPerMinute) + ' minutes ago';
    }

    else if (elapsed < msPerDay ) {
         return Math.round(elapsed/msPerHour ) + ' hours ago';
    }

    else if (elapsed < msPerMonth) {
        return Math.round(elapsed/msPerDay) + ' days ago';
    }

    else if (elapsed < msPerYear) {
        return Math.round(elapsed/msPerMonth) + ' months ago';
    }

    else {
        return Math.round(elapsed/msPerYear ) + ' years ago';
    }
}

function passes_spam_filter(contacts, ev, pow)
{
	if (contacts.friend_of_friends.has(ev.pubkey))
		return true

	return ev.pow >= pow
}

