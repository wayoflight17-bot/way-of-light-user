/*
 * sw.js — Service Worker handling two distinct notification features for this app:
 *
 * 1. EXAM GRACE-PERIOD NOTIFICATION (message-triggered, tab must be open somewhere)
 *    Shows a system notification when a student leaves an active exam (screen off, incoming
 *    call, app switch), and closes it again once they return in time. The actual 15-second
 *    countdown, Page Visibility detection, and pass/fail decision all live in the main page's
 *    JavaScript (user_portal.html) — this worker only displays/clears the notification on
 *    request via postMessage. It does NOT and CANNOT run an accurate background timer itself;
 *    browsers suspend idle workers within seconds, and a worker has no `document` so it can't
 *    see document.visibilityState at all.
 *
 * 2. CONTENT PUSH NOTIFICATIONS (true push, works even with the site fully closed)
 *    New season started, new test published, new study material posted, winners announced.
 *    These arrive via the browser's native 'push' event — the OS/browser wakes this worker on
 *    its own, with no tab needing to be open. This is only possible because a server (the
 *    Cloud Function in functions/index.js, deployed separately) holds the private VAPID key and
 *    actually sends the push through Firebase Cloud Messaging. This file cannot and does not
 *    decide WHEN to notify for new content — it only renders whatever payload it's given.
 *
 * Deployment: this file must sit in the same folder as user_portal.html (or otherwise be served
 * such that its scope covers the page registering it). Service Worker registration requires
 * HTTPS (or localhost for local testing) — it will silently fail to register over plain HTTP on
 * a real domain, which is expected browser behavior, not a bug in this file.
 */

const NOTIFICATION_TAG = 'exam-grace-period';
const DEFAULT_ICON = 'logo.jpeg';

self.addEventListener('install', (event) => {
    // Activate this worker as soon as it's installed, without waiting for old tabs to close.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Take control of any already-open page immediately, so a notification can be requested
    // right away without needing a page reload first.
    event.waitUntil(self.clients.claim());
});

// The page sends a postMessage() to this worker (via its registration's active worker) when it
// wants the EXAM GRACE-PERIOD notification shown or cleared. This path is unrelated to the
// content-push feature below — it only ever fires while a tab is open, since it's triggered by
// in-page JavaScript, not a server push.
self.addEventListener('message', (event) => {
    const data = event.data || {};

    if (data.type === 'SHOW_GRACE_NOTIFICATION') {
        const title = data.title || 'Return to your exam';
        const body = data.body || 'You have 15 seconds to return before your exam is automatically submitted.';
        event.waitUntil(
            self.registration.showNotification(title, {
                body,
                tag: NOTIFICATION_TAG,       // re-using the same tag replaces any previous one
                renotify: true,               // re-alert (vibrate/sound) even if a previous one is still showing
                requireInteraction: true,     // stays visible until the user acts, doesn't auto-dismiss
                icon: data.icon || DEFAULT_ICON,
                badge: data.icon || DEFAULT_ICON,
                vibrate: [200, 100, 200],
                data: { url: data.url || '/' }
            })
        );
    }

    if (data.type === 'CLEAR_GRACE_NOTIFICATION') {
        event.waitUntil(
            self.registration.getNotifications({ tag: NOTIFICATION_TAG }).then((notifications) => {
                notifications.forEach((n) => n.close());
            })
        );
    }
});

// ===========================================================================
// CONTENT PUSH NOTIFICATIONS — new season / test / study material / winners
// ===========================================================================
// Fired by the browser itself when a push arrives from the server (the Cloud Function), even if
// no tab for this site is open anywhere. The payload's shape is defined by what the Cloud
// Function sends (see functions/index.js) — this handler just needs to agree on that shape.
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        // Fall back to plain text if the payload wasn't JSON for some reason.
        payload = { title: 'Way of Light', body: event.data ? event.data.text() : 'You have a new notification.' };
    }

    const title = payload.title || 'Way of Light';
    const options = {
        body: payload.body || '',
        icon: payload.icon || DEFAULT_ICON,
        badge: payload.icon || DEFAULT_ICON,
        // Each content type gets its own tag, so e.g. a new season notification doesn't replace
        // a still-unread "new test" notification — unlike the single-slot grace-period alert,
        // these are allowed to stack since they're informational, not time-critical.
        tag: payload.tag || 'general',
        vibrate: [150, 75, 150],
        data: { url: payload.url || '/', type: payload.type || 'general' }
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping any notification should bring an existing tab into focus rather than opening a
// duplicate one, and (for content notifications) deep-link to a relevant view via the URL hash
// so the page can route itself once it loads. The exam grace-period notification doesn't need a
// hash — focusing the tab is enough, since the exam is already on screen.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
            for (const client of clientsArr) {
                // Focus an already-open tab rather than opening a new one, if we can find one.
                if ('focus' in client) {
                    if ('navigate' in client && targetUrl !== '/') {
                        client.navigate(targetUrl).catch(() => {});
                    }
                    return client.focus();
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow(targetUrl);
            }
        })
    );
});
