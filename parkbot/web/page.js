// Live view for the Citizens Park page.
//
// The page ships with the next few days of bookings and rain as JSON. This
// script works out what "now" is in the park's own time zone and draws the
// answer, so the page stays right through the day, and even if a scheduled
// rebuild is late. It re-reads data.json from time to time for fresh data.
(function () {
  "use strict";

  var holder = document.getElementById("park-data");
  var app = document.getElementById("app");
  if (!holder || !app) return;

  var data;
  try {
    data = JSON.parse(holder.textContent);
  } catch (error) {
    return; // keep the plain version that came with the page
  }

  var NBSP = String.fromCharCode(160);
  var LIKELY = 50;
  var SLIGHT = 20;
  var LAST_RAIN_HOUR = 21;
  var lastFetch = Date.now();
  var shown = "";

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function clock(minutes, withHalf) {
    if (minutes === 0 || minutes === 1440) return "midnight";
    var hour = Math.floor(minutes / 60);
    var minute = minutes % 60;
    var hour12 = hour % 12 || 12;
    var text = minute ? hour12 + ":" + (minute < 10 ? "0" : "") + minute : String(hour12);
    // A non-breaking space keeps "4" and "PM" on the same line.
    return withHalf === false ? text : text + (hour < 12 ? NBSP + "AM" : NBSP + "PM");
  }

  function span(slot) {
    var sameHalf = slot[0] < 720 === slot[1] < 720 && slot[1] !== 1440 && slot[0] !== 0;
    return clock(slot[0], !sameHalf) + " to " + clock(slot[1]);
  }

  function spans(slots) {
    var parts = slots.map(span);
    if (parts.length <= 1) return parts.join("");
    return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  }

  // The date and time in the park's time zone, wherever the reader is.
  function parkNow() {
    var forced = /[?&]now=(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)/.exec(window.location.search);
    if (forced) return { date: forced[1], minute: Number(forced[2]) * 60 + Number(forced[3]) };
    var parts = {};
    new Intl.DateTimeFormat("en-AU", {
      timeZone: data.zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(new Date())
      .forEach(function (part) {
        parts[part.type] = part.value;
      });
    return {
      date: parts.year + "-" + parts.month + "-" + parts.day,
      minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute)
    };
  }

  function percent(minute) {
    var length = data.lightsOff - data.dayStart;
    return Math.max(0, Math.min(100, ((minute - data.dayStart) / length) * 100));
  }

  // ---- The answer at the top ----

  function answer(day, minute) {
    var sure = day.basis === "council";
    if (day.closed) {
      return {
        state: "closed",
        title: "Oval closed today",
        sub: day.label ? "Council notice: " + day.label : "The council has closed the oval."
      };
    }
    if (day.basis === "none") {
      return { state: "unknown", title: "No booking information today", sub: "Check the signs at the park." };
    }

    var current = null;
    var next = null;
    day.slots.forEach(function (slot) {
      if (slot[0] <= minute && minute < slot[1]) current = slot;
      else if (slot[0] > minute && !next) next = slot;
    });

    if (current) {
      return {
        state: "booked",
        title: sure ? "Booked right now" : "Usually booked now",
        sub: (sure ? "Until " : "Usually until ") + clock(current[1]) + (day.label ? " (" + day.label + ")." : "."),
        rule: "Dogs must stay off the oval while sport or training is on."
      };
    }
    if (!day.slots.length && day.label) {
      return { state: "unknown", title: day.label + " listed today", sub: "The oval may be closed. Check the signs at the park." };
    }
    if (next) {
      return {
        state: "free",
        title: sure ? "Free for dogs right now" : "Probably free right now",
        sub: (sure ? "Until " : "Usually until ") + clock(next[0]) + ", then booked to " + clock(next[1]) + "."
      };
    }
    if (day.slots.length) {
      return {
        state: "free",
        title: sure ? "Free for the rest of today" : "Probably free for the rest of today",
        sub: sure ? "Today's bookings have finished." : "The usual booking time has passed."
      };
    }
    return {
      state: "free",
      title: sure ? "Free for dogs all day" : "Probably free all day",
      sub: sure ? "No bookings today." : "There is usually no booking on this day."
    };
  }

  function pill(day) {
    if (day.closed) return { sure: "yes", text: "From a notice on the council’s page" };
    if (day.basis === "council") return { sure: "yes", text: "From the council’s schedule" };
    if (day.basis === "usual") return { sure: "no", text: "Usual pattern, not confirmed" };
    if (day.basis === "rough") return { sure: "no", text: "Rough guide only" };
    return null;
  }

  function heroHtml(day, now) {
    var found = answer(day, now.minute);
    var badge = pill(day);
    return (
      '<section class="hero" data-state="' + found.state + '">' +
      '<p class="kicker">' + esc(day.name) + ", " + clock(now.minute) + "</p>" +
      "<h1>" + esc(found.title) + "</h1>" +
      '<p class="sub">' + esc(found.sub) + "</p>" +
      (found.rule ? '<p class="rule">' + esc(found.rule) + "</p>" : "") +
      (badge ? '<p class="pill" data-sure="' + badge.sure + '">' + esc(badge.text) + "</p>" : "") +
      "</section>"
    );
  }

  // ---- Today ----

  function segments(day) {
    if (day.closed) return '<span class="seg" style="left:0;width:100%"></span>';
    return day.slots
      .map(function (slot) {
        var left = percent(slot[0]);
        var width = percent(slot[1]) - left;
        return width > 0 ? '<span class="seg" style="left:' + left.toFixed(2) + "%;width:" + width.toFixed(2) + '%"></span>' : "";
      })
      .join("");
  }

  function ticksHtml() {
    var html = "";
    for (var hour = Math.ceil(data.dayStart / 180) * 3; hour * 60 <= data.lightsOff; hour += 3) {
      var label = hour === 12 ? "noon" : clock(hour * 60);
      html += '<span style="left:' + percent(hour * 60).toFixed(2) + '%">' + label + "</span>";
    }
    return html;
  }

  function timesHtml(day) {
    if (day.closed) return '<li><span class="key booked"></span>Closed all day</li>';
    if (day.basis === "none") return "<li>No booking information</li>";
    var usual = day.basis !== "council";
    if (!day.slots.length) {
      if (day.label) return "<li>" + esc(day.label) + " listed</li>";
      return '<li><span class="key"></span>' + (usual ? "Usually no bookings" : "No bookings") + "</li>";
    }
    return (
      '<li><span class="key booked"></span>' +
      (usual ? "Usually booked " : "Booked ") +
      esc(spans(day.slots)) +
      (day.label ? " (" + esc(day.label) + ")" : "") +
      "</li>"
    );
  }

  function outlook(hours, minute) {
    var nowHour = Math.floor(minute / 60);
    var ahead = (hours || []).filter(function (hour) {
      return hour[0] >= nowHour && hour[0] <= LAST_RAIN_HOUR && hour[1] !== null;
    });
    if (!ahead.length) return { level: "unknown", text: "No rain forecast available." };

    var peak = ahead[0];
    var mm = 0;
    ahead.forEach(function (hour) {
      if (hour[1] > peak[1]) peak = hour;
      mm += hour[2] || 0;
    });
    var amount = mm < 0.05 ? "" : mm < 0.75 ? "under 1" + NBSP + "mm" : "about " + Math.round(mm) + NBSP + "mm";

    if (peak[1] < SLIGHT) return { level: "dry", text: "No rain expected for the rest of today." };
    if (peak[1] < LIKELY) {
      return { level: "slight", text: "Slight chance of rain (" + peak[1] + "% around " + clock(peak[0] * 60) + ")." };
    }

    var runs = [];
    ahead.forEach(function (hour) {
      if (hour[1] < LIKELY) return;
      var last = runs[runs.length - 1];
      if (last && last[last.length - 1] === hour[0] - 1) last.push(hour[0]);
      else runs.push([hour[0]]);
    });
    var first = runs[0][0];
    var last = runs[0][runs[0].length - 1];
    var startsNow = first <= nowHour;
    var runsOut = last >= ahead[ahead.length - 1][0];
    var when;
    if (startsNow && runsOut) when = "for the rest of today";
    else if (startsNow) when = "until about " + clock((last + 1) * 60);
    else if (runsOut) when = "from about " + clock(first * 60);
    else when = "between " + clock(first * 60) + " and " + clock((last + 1) * 60);
    var text = "Rain likely " + when + " (up to " + peak[1] + "%" + (amount ? ", " + amount : "") + ").";
    if (runs.length > 1) text += " More from about " + clock(runs[1][0] * 60) + ".";
    return { level: "likely", text: text };
  }

  function rainHtml(day, minute, live) {
    if (!day.hours) {
      if (!day.rain || day.rain.chance === null) return "";
      return '<div class="rain"><p class="rain-text">Chance of rain: <strong>' + day.rain.chance + "%</strong></p></div>";
    }
    var look = live ? outlook(day.hours, minute) : null;
    var firstHour = Math.floor(data.dayStart / 60);
    var lastHour = Math.ceil(data.lightsOff / 60) - 1;
    var bars = "";
    var top = 0;
    day.hours.forEach(function (hour) {
      if (hour[0] < firstHour || hour[0] > lastHour) return;
      var chance = hour[1] === null ? 0 : hour[1];
      top = Math.max(top, chance);
      var title = clock(hour[0] * 60) + ": " + (hour[1] === null ? "no forecast" : chance + "%" + (hour[2] ? ", " + hour[2] + " mm" : ""));
      bars +=
        '<span style="height:' + Math.max(4, chance) + '%" title="' + esc(title) + '"' +
        (live && hour[0] < Math.floor(minute / 60) ? ' data-past="yes"' : "") +
        "></span>";
    });
    return (
      '<div class="rain">' +
      (look ? '<p class="rain-text">' + esc(look.text) + "</p>" : "") +
      (data.rainFrom ? '<p class="rain-caption">Forecast from ' + esc(data.rainFrom) + ".</p>" : "") +
      '<div class="rain-bars" role="img" aria-label="Chance of rain for each hour, highest ' + top + ' percent">' + bars + "</div>" +
      '<p class="rain-caption">Chance of rain by the hour, ' + clock(firstHour * 60) + " to " + clock((lastHour + 1) * 60) + ". A full-height bar is 100%.</p>" +
      "</div>"
    );
  }

  function todayHtml(day, now) {
    var sure = day.basis === "council" ? "yes" : "no";
    var known = day.basis === "none" ? "no" : "yes";
    var inDay = now.minute >= data.dayStart && now.minute <= data.lightsOff;
    return (
      '<section class="card">' +
      "<h2>Today <span>" + esc(day.name) + "</span></h2>" +
      '<div class="timeline">' +
      '<div class="bar-wrap"><div class="bar" data-sure="' + sure + '" data-known="' + known + '">' + segments(day) + "</div>" +
      (inDay ? '<span class="now-line" style="left:' + percent(now.minute).toFixed(2) + '%" title="Now"></span>' : "") +
      "</div>" +
      '<div class="ticks" aria-hidden="true">' + ticksHtml() + "</div>" +
      "</div>" +
      '<ul class="times">' + timesHtml(day) + "</ul>" +
      rainHtml(day, now.minute, true) +
      (day.note ? '<p class="source" data-sure="' + sure + '">' + esc(day.note) + "</p>" : "") +
      "</section>"
    );
  }

  // ---- The week ahead ----

  function dayText(day) {
    if (day.closed) return "Closed";
    if (day.basis === "none") return "No information";
    var text = day.slots.length ? spans(day.slots) : day.label ? day.label : "No bookings";
    if (day.slots.length && day.label) text += " (" + day.label + ")";
    return text;
  }

  function weekHtml(days) {
    if (!days.length) return "";
    var isUsual = function (day) {
      return day.basis === "usual" || day.basis === "rough";
    };
    var anyUsual = days.some(isUsual);
    // When the whole week is the usual pattern, say so once instead of on every row.
    var allUsual = days.every(function (day) {
      return isUsual(day) || day.basis === "none";
    }) && anyUsual;
    var rows = days
      .map(function (day) {
        var usual = isUsual(day) && !allUsual;
        var chance = day.rain ? day.rain.chance : null;
        var rain = chance === null ? "" : chance >= SLIGHT ? "Rain " + chance + "%" : "Dry";
        var parts = day.name.split(" ");
        return (
          '<li class="day">' +
          '<div class="day-name">' + esc(parts[0]) + "<small>" + esc(parts.slice(1).join(" ")) + "</small></div>" +
          '<div class="day-main"><div class="day-text">' + esc(dayText(day)) + (usual ? ' <span class="tag">usual</span>' : "") + "</div>" +
          '<div class="mini" data-known="' + (day.basis === "none" ? "no" : "yes") + '">' + segments(day) + "</div></div>" +
          '<div class="day-rain" data-dry="' + (chance !== null && chance >= SLIGHT ? "no" : "yes") + '">' + rain + "</div>" +
          "</li>"
        );
      })
      .join("");
    return (
      '<section class="card">' +
      "<h2>The week ahead " + (allUsual ? '<span class="tag">usual pattern</span>' : "<span>booked times</span>") + "</h2>" +
      '<ol class="days">' + rows + "</ol>" +
      '<p class="legend"><span class="key"></span>free<span class="key booked"></span>booked, ' +
      clock(data.dayStart) + " to " + clock(data.lightsOff) + "." +
      (allUsual
        ? " These are the usual times, not yet confirmed by the council."
        : anyUsual
          ? ' <span class="tag">usual</span> means the usual pattern, not yet confirmed by the council.'
          : "") +
      "</p></section>"
    );
  }

  // ---- Putting it together ----

  function staleHtml() {
    var built = Date.parse(data.generated);
    if (isNaN(built) || Date.now() - built < 26 * 3600 * 1000) return "";
    return '<p class="stale">This page has not updated since ' + esc(data.generatedText) + ". The times may be out of date.</p>";
  }

  function render() {
    var now = parkNow();
    var index = -1;
    data.days.forEach(function (day, i) {
      if (day.date === now.date) index = i;
    });
    var html = staleHtml();
    if (index === -1) {
      html +=
        '<section class="hero" data-state="unknown"><p class="kicker">' + clock(now.minute) + "</p>" +
        "<h1>No information for today</h1>" +
        '<p class="sub">This page is out of date. Check the signs at the park or the council’s page.</p></section>';
      html += weekHtml(data.days.filter(function (day) { return day.date > now.date; }));
    } else {
      html += heroHtml(data.days[index], now) + todayHtml(data.days[index], now) + weekHtml(data.days.slice(index + 1, index + 8));
    }
    if (html !== shown) {
      app.innerHTML = html;
      shown = html;
    }
    var checked = document.getElementById("checked");
    if (checked && data.generatedText) checked.textContent = "Last checked " + data.generatedText + ".";
  }

  function refresh() {
    lastFetch = Date.now();
    if (!window.fetch) return;
    fetch("data.json?t=" + lastFetch, { cache: "no-store" })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (fresh) {
        if (fresh && fresh.days && fresh.generated && fresh.generated !== data.generated) {
          data = fresh;
          render();
        }
      })
      .catch(function () {});
  }

  render();
  setInterval(render, 30 * 1000);
  setInterval(refresh, 15 * 60 * 1000);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    render();
    if (Date.now() - lastFetch > 5 * 60 * 1000) refresh();
  });

  // ---- Share button ----

  var share = document.getElementById("share");
  if (share) {
    share.addEventListener("click", function () {
      var address = data.site || window.location.href;
      var label = share.textContent;
      var done = function (text) {
        share.textContent = text;
        setTimeout(function () {
          share.textContent = label;
        }, 2500);
      };
      if (navigator.share) {
        navigator.share({ title: document.title, text: "Is the oval free for dogs right now?", url: address }).catch(function () {});
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(address).then(
          function () { done("Link copied"); },
          function () { done(address); }
        );
      } else {
        done(address);
      }
    });
  }
})();
