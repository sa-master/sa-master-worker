SA-MASTER — jobs.js: прибрати самовидалення майстром
=====================================================

У поточному handlers/jobs.js зробіть ТІЛЬКИ ці зміни.

1) У блоці /start для ACTIVE майстра видаліть кнопку:

[
  {
    text: "🗑 Видалити профіль",
    callback_data: "delete_profile_ask",
  },
],

Після цього masterButtons має бути:

const masterButtons = [
  [
    {
      text: "👥 Увійти в групу заявок",
      callback_data: "get_group_invite",
    },
  ],
  [
    {
      text: "➕ Передати заявку",
      callback_data: "submit_request",
    },
  ],
];


2) У блоці /start для INACTIVE майстра видаліть кнопку:

[
  {
    text: "🗑 Видалити профіль",
    callback_data: "delete_profile_ask",
  },
],

Залиште:

await sendToMaster(
  env,
  chatId,
  inactiveText,
  [
    [
      {
        text: "👥 Увійти в групу заявок",
        callback_data: "get_group_invite",
      },
    ],
  ]
);


3) ПОВНІСТЮ ВИДАЛІТЬ блоки callback:

if (data === "delete_profile_ask") {
  ...
}

if (data === "delete_profile_cancel") {
  ...
}

if (data === "delete_profile_confirm") {
  ...
}

Тобто весь розділ:

/* -----------------------------------------------------
 * Самостійне видалення профілю майстром
 * ----------------------------------------------------- */

разом із трьома callback-обробниками треба видалити.


4) Після цього import:

banMasterFromJobsGroup,

на початку jobs.js більше не використовується логікою самовидалення.

У наданому jobs.js інших використань banMasterFromJobsGroup немає,
тому видаліть його з import:

import {
  sendToJobsGroup,
  editJobsMessage,
  answerJobsCallback,
  sendToMaster,
  createInviteForMaster,
} from "../lib/telegram-jobs.js";


5) НЕ ЗМІНЮВАТИ решту jobs.js.

Зокрема залишаються:
- active / inactive / blocked;
- автоматичний inactive при left_chat_member;
- active при new_chat_members;
- повторне персональне запрошення;
- передача заявки;
- take;
- outcome;
- анкети;
- referral;
- статистика.

РЕЗУЛЬТАТ
---------
Майстер:
- може вийти з групи -> профіль та історія залишаються;
- не має кнопки видалення профілю;
- не може викликати старі delete_profile_* callback-и.

Повне видалення виконується тільки адміністратором через @sa_master_pro_bot.
