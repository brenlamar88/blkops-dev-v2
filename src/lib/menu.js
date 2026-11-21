// Single source of truth for the sidebar. The nav renders from it, per-user
// visibility filters it, and the Users admin screen lists the same items as
// toggles — all keyed by route path so a menu_key in user_menu_visibility
// always matches a real destination.

export const MENU = [
  ['Daily work', [['/', 'Dashboard'], ['/portfolio', 'My portfolio'],
                  ['/activities', 'Activities'], ['/referrals', 'Referrals'],
                  ['/rotation-schedules', 'Rotation schedules']]],
  ['Accounts', [['/companies', 'Companies'], ['/contacts', 'Contacts'],
                ['/territories', 'Territories'], ['/needs-analysis', 'Needs analysis'],
                ['/prospectus', 'Prospectus'], ['/verification', 'Verification']]],
  // The Report Center (/reports) is the hub for the daily/weekly/monthly/review
  // reports, so those live behind it rather than cluttering the sidebar.
  ['Reporting', [['/reports', 'Report center'],
                 ['/sdd-workbook', 'SDD workbook'],
                 ['/activity-dashboard', 'Activity dashboard'],
                 ['/touch-analysis', 'Touch analysis'],
                 ['/referral-scorecard', 'Referral scorecard'],
                 ['/mis', 'MIS'],
                 ['/five-star', '5 Star report'],
                 ['/surveys', '5 Star surveys'],
                 ['/reports/logs', 'Activity/Referral Reports']]],
]

// Shown only to managers/admins; Users, Campuses and City check are admin-only.
export const ADMIN_MENU = ['Admin', [['/territory-map', 'Territory map'],
                                     ['/city-check', 'City check'],
                                     ['/five-star-all', '5 Star report (all)'],
                                     ['/marketing-settings', 'Programs & goals'],
                                     ['/program-eligibility', 'Program eligibility'],
                                     ['/users', 'Users'], ['/campuses', 'Campuses']]]

// Admin-only nav items (managers see the rest of the Admin group but not these).
export const ADMIN_ONLY = ['/users', '/campuses', '/city-check', '/five-star-all', '/program-eligibility', '/marketing-settings']

// Dashboard is the landing page and never hideable, so it is not a toggle.
export const HIDEABLE_ITEMS = [...MENU, ADMIN_MENU]
  .flatMap(([group, items]) => items.map(([key, label]) => ({ key, label, group })))
  .filter((i) => i.key !== '/')
