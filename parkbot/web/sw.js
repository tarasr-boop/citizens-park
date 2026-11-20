// Shows the daily alert as a notification.
//
// A browser keeps this script apart from the page and wakes it when an alert
// arrives, even while the page is closed. It does nothing else: it keeps no
// copy of the page and leaves the page's own requests alone.
//
// An alert normally brings its own words. If one ever arrives without them,
// this script reads today's notice from the page's data instead.
"use strict";

var FALLBACK = { title: "Today's update is ready", body: "Tap to see when the oval is booked." };
// How long to wait for the page's data before showing the plain notice instead.
var PATIENCE = 8000;

// A new version of this script takes over straight away.
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

function pageData() {
  return fetch("data.json?t=" + Date.now(), { cache: "no-store" }).then(function (response) {
    if (!response.ok) throw new Error("the page's data did not load");
    return response.json();
  });
}

// Today's date where the park is, such as "2026-11-20".
function dateIn(zone) {
  var parts = {};
  new Intl.DateTimeFormat("en-AU", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date())
    .forEach(function (part) {
      parts[part.type] = part.value;
    });
  return parts.year + "-" + parts.month + "-" + parts.day;
}

function noticeFromPage() {
  var wait = new Promise(function (resolve, reject) {
    setTimeout(function () {
      reject(new Error("the page's data took too long"));
    }, PATIENCE);
  });
  var read = pageData().then(function (data) {
    var today = dateIn(data.zone);
    var found = (data.days || []).filter(function (day) {
      return day.date === today && day.notice && day.notice.title;
    })[0];
    if (!found) throw new Error("the page's data has no notice for today");
    return { title: found.notice.title, body: found.notice.body };
  });
  return Promise.race([read, wait]);
}

// The words an alert brought with it, or null. They arrive in the shape
// {"web_push": 8030, "notification": {"title": ..., "body": ..., "navigate": ...}},
// which newer iPhones can show by themselves, without this script.
function noticeFromAlert(event) {
  try {
    var sent = event.data ? event.data.json() : null;
    var notice = sent && sent.notification;
    return notice && typeof notice.title === "string" && notice.title ? notice : null;
  } catch (error) {
    return null;
  }
}

// Only ever open this page: never an address from somewhere else.
function ownAddress(address) {
  var home = self.registration.scope;
  return typeof address === "string" && address.indexOf(home) === 0 ? address : home;
}

function show(notice) {
  return self.registration.showNotification(String(notice.title), {
    body: typeof notice.body === "string" ? notice.body : "",
    // One notification at a time: today's takes the place of yesterday's, and
    // still makes itself heard.
    tag: typeof notice.tag === "string" && notice.tag ? notice.tag : "daily",
    renotify: true,
    icon: "icon-192.png",
    badge: "badge.png",
    lang: "en-AU",
    data: { url: ownAddress(notice.navigate) }
  });
}

self.addEventListener("push", function (event) {
  var notice = noticeFromAlert(event);
  event.waitUntil(
    (notice ? Promise.resolve(notice) : noticeFromPage())
      .catch(function () {
        return FALLBACK;
      })
      .then(show)
  );
});

// A tap on the notification opens the page, or brings it forward if it is open.
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var address = ownAddress(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      for (var index = 0; index < windows.length; index += 1) {
        if (windows[index].url.indexOf(self.registration.scope) === 0 && windows[index].focus) return windows[index].focus();
      }
      return self.clients.openWindow(address);
    })
  );
});

function tell(backend, path, body) {
  return fetch(backend + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// Now and then a browser replaces the address it gave this device for
// notifications. The backend is told the new one, so the alerts keep coming.
self.addEventListener("pushsubscriptionchange", function (event) {
  var old = event.oldSubscription || null;
  var options = old && old.options;
  event.waitUntil(
    pageData()
      .then(function (data) {
        var backend = /^https:\/\/\S+$/.test(data.push || "") ? String(data.push).replace(/\/+$/, "") : "";
        if (!backend) return null;
        var renewed = event.newSubscription
          ? Promise.resolve(event.newSubscription)
          : options && options.applicationServerKey
            ? self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey })
            : Promise.resolve(null);
        return renewed.then(function (subscription) {
          if (!subscription) return null;
          var jobs = [tell(backend, "/subscribe", { subscription: subscription.toJSON() })];
          if (old && old.endpoint && old.endpoint !== subscription.endpoint) {
            jobs.push(tell(backend, "/unsubscribe", { endpoint: old.endpoint }));
          }
          return Promise.all(jobs);
        });
      })
      .catch(function () {})
  );
});
