export const QUESTIONS = {
  "3": "Discharge notification was provided at least 48hrs prior to discharge for the patient.",
  "13": "Discharge summary and information accompanied the patient upon return home/facility.",
  "14": "Patient arrived at home/facility with all their belongings.",
  "15": "Patient returned to home/facility with proper hygiene.",
  "16": "Positive changes noticeable in the patient\u2019s condition.",
  "17": "In general, rank services at Freedom Behavioral.",
  "18": "In general, rank patient's overall health upon discharge.",
  "28": "Referral call was handled in a timely manner.",
  "29": "Individual who took the call was respectful, informative and clear on the referral process.",
  "30": "Pre-screen evaluation on site was performed during convenience of patient/facility.",
  "31": "Service Development Representative offered to speak with the patient\u2019s family on the services provided?",
  "32": "Service Development Representative kept in constant contact on the status of the referral approval/denial.",
  "33": "Service Development Representative assisted in alternate placement if Freedom was unable to meet the patient\u2019s needs?",
  "34": "Service Development Representative was professional and supportive throughout the referral process.",
  "35": "Informed about the opportunity to tour the facility?",
  "36": "Patient personal belonging policy was discussed during the process.",
  "37": "Family was encouraged to accompany the patient upon admission to be part of the assessment/intake.",
  "38": "Referring source was notified upon patient's arrival to the facility.",
  "39": "Transportation was set up timely to meet the patient's need for treatment, when applicable.",
  "40": "Nurse to nurse contact was made prior to the assessment to gather additional information on the patient.",
  "41": "Referring source was updated on patient's programming progress through the stay.",
  "42": "Freedom staff communicated an update on the plan of care and discharge goals."
}
export const GROUPS = {
  "Discharge": [
    "3",
    "13",
    "14",
    "15",
    "16",
    "17",
    "18"
  ],
  "Referral": [
    "28",
    "29",
    "30",
    "31",
    "32",
    "33",
    "34",
    "35"
  ],
  "Admission": [
    "36",
    "37",
    "38",
    "39",
    "40",
    "41",
    "42"
  ]
}
export const FOLLOW_UPS = [
  {
    "rating": "42",
    "detail": "65",
    "operator": "greaterThan",
    "value": 4
  },
  {
    "rating": "41",
    "detail": "64",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "40",
    "detail": "63",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "39",
    "detail": "62",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "38",
    "detail": "61",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "37",
    "detail": "60",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "36",
    "detail": "59",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "18",
    "detail": "58",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "17",
    "detail": "57",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "16",
    "detail": "56",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "15",
    "detail": "54",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "14",
    "detail": "51",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "35",
    "detail": "53",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "34",
    "detail": "52",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "33",
    "detail": "50",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "31",
    "detail": "48",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "30",
    "detail": "47",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "32",
    "detail": "49",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "29",
    "detail": "43",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "3",
    "detail": "43",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "28",
    "detail": "45",
    "operator": "lessThan",
    "value": 4
  },
  {
    "rating": "13",
    "detail": "44",
    "operator": "lessThan",
    "value": 4
  }
]
export function visibleFollowUps(ratings) {
 return FOLLOW_UPS.filter(r => ratings[r.rating] && (r.operator === 'lessThan' ? Number(ratings[r.rating]) < r.value : Number(ratings[r.rating]) > r.value))
}
export function cleanAnswers(type, ratings, details) {
 const selected = Object.fromEntries((GROUPS[type] || []).map(id => [id, Number(ratings[id])]))
 const visible = new Set(visibleFollowUps(selected).map(r => r.detail))
 return { ratings: selected, details: Object.fromEntries(Object.entries(details).filter(([id]) => visible.has(id))) }
}
