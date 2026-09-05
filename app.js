// --- STATE & DOM ---
// Fix #4: JSON.parse ahora con try/catch — si localStorage está corrupto,
// la app arranca con lista vacía en vez de romperse por completo.
let debts = [];
try {
    debts = JSON.parse(localStorage.getItem('debts')) || [];
} catch (err) {
    console.error('debts corrupto en localStorage, reiniciando lista:', err);
    debts = [];
}

const form = document.getElementById('debt-form');
const list = document.getElementById('debt-list');
const totalEl = document.getElementById('total-owed');
const btnClearCache = document.getElementById('btn-clear-cache');
const repeatsSelect = document.getElementById('repeats');
const customDaysField = document.getElementById('custom-days-field');
const dayPicker = document.getElementById('day-picker');
const submitBtn = document.getElementById('submit-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');

// id de la deuda que se está editando actualmente (null = modo "agregar")
let editingId = null;

// --- SELECTOR DE DÍAS FIJOS (para recurrencia "custom-days") ---
// El usuario elige libremente cualquier combinación de días del mes
// (no limitado a 2 fechas tipo "5 y 20" — puede ser 1, 3, 5, las que sean).
let selectedDays = new Set();

for (let d = 1; d <= 31; d++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = d;
    btn.dataset.day = d;
    btn.addEventListener('click', () => {
        if (selectedDays.has(d)) {
            selectedDays.delete(d);
            btn.classList.remove('selected');
        } else {
            selectedDays.add(d);
            btn.classList.add('selected');
        }
    });
    dayPicker.appendChild(btn);
}

function resetDayPicker() {
    selectedDays = new Set();
    dayPicker.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
}

// --- RECURRENCIA ---
// Fechas se manejan como Date locales (no UTC) para evitar que un "5" se
// convierta en "4" por desfase de huso horario al usar new Date("YYYY-MM-DD").
function parseDateStr(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
}
function formatDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
function clampDay(year, month, day) {
    // Protege meses con menos de 31 días (ej. día 31 en febrero -> último día real)
    const lastDay = new Date(year, month + 1, 0).getDate();
    return Math.min(day, lastDay);
}

function getNextDueDate(currentDueStr, recurrence) {
    const current = parseDateStr(currentDueStr);

    if (recurrence.type === 'monthly') {
        const next = new Date(current.getFullYear(), current.getMonth() + 1, 1);
        next.setDate(clampDay(next.getFullYear(), next.getMonth(), recurrence.day));
        return formatDateStr(next);
    }

    if (recurrence.type === 'custom-days') {
        const days = [...recurrence.days].sort((a, b) => a - b); // ej. [5, 20] o los que el usuario eligió
        const currentDay = current.getDate();
        const nextDayInSameMonth = days.find(d => d > currentDay);

        if (nextDayInSameMonth !== undefined) {
            const day = clampDay(current.getFullYear(), current.getMonth(), nextDayInSameMonth);
            return formatDateStr(new Date(current.getFullYear(), current.getMonth(), day));
        }
        // ya pasamos la última fecha del mes -> saltar a la primera fecha del mes siguiente
        const nextMonth = new Date(current.getFullYear(), current.getMonth() + 1, 1);
        const day = clampDay(nextMonth.getFullYear(), nextMonth.getMonth(), days[0]);
        return formatDateStr(new Date(nextMonth.getFullYear(), nextMonth.getMonth(), day));
    }

    return null;
}

// Conserva el mismo "adelanto" del recordatorio respecto al vencimiento
// (ej. si avisabas 2 días antes, la próxima ocurrencia también avisa 2 días antes).
function getNextReminderDate(currentDueStr, currentReminderStr, nextDueStr) {
    if (!currentReminderStr) return null;
    const diffMs = new Date(currentReminderStr) - parseDateStr(currentDueStr);
    const nextReminder = new Date(parseDateStr(nextDueStr).getTime() + diffMs);
    const y = nextReminder.getFullYear();
    const mo = String(nextReminder.getMonth() + 1).padStart(2, '0');
    const da = String(nextReminder.getDate()).padStart(2, '0');
    const h = String(nextReminder.getHours()).padStart(2, '0');
    const mi = String(nextReminder.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${da}T${h}:${mi}`;
}

repeatsSelect.addEventListener('change', () => {
    customDaysField.hidden = repeatsSelect.value !== 'custom-days';
});

// --- NOTIFICACIONES ---
// Fix #2 (parcial, ver nota abajo): antes solo se revisaba una vez al abrir
// la app. Ahora se revisa al abrir Y cada 60s mientras la app está abierta.
// IMPORTANTE — límite real: mientras la pestaña/app esté cerrada, el navegador
// NO ejecuta este código, así que un recordatorio no se disparará si la app
// no está abierta en ese momento. Para avisos 100% confiables con la app
// cerrada se necesita Periodic Background Sync (soporte muy limitado, sobre
// todo en Android/Chrome instalado) o un servidor con push notifications.
// Este parche resuelve el caso más común (app abierta en segundo plano) pero
// no el caso de "teléfono guardado con la app cerrada".
let reminderInterval = null;

async function initNotifications() {
    if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
    }
    checkReminders();

    if (!reminderInterval) {
        reminderInterval = setInterval(checkReminders, 60 * 1000);
    }

    // Intento best-effort de Periodic Background Sync (si el navegador lo soporta)
    if ('serviceWorker' in navigator && 'PeriodicSyncManager' in window) {
        try {
            const registration = await navigator.serviceWorker.ready;
            await registration.periodicSync.register('check-debt-reminders', {
                minInterval: 12 * 60 * 60 * 1000 // cada 12h, mínimo que suele permitir el navegador
            });
        } catch (err) {
            // No disponible o no otorgado — no es crítico, ya tenemos el chequeo cada 60s en primer plano.
            console.log('Periodic Background Sync no disponible:', err);
        }
    }
}

function checkReminders() {
    if (Notification.permission !== 'granted') return;
    const now = new Date();

    debts.forEach(debt => {
        if (debt.status === 'pending' && debt.reminderDate && !debt.reminderSent && new Date(debt.reminderDate) <= now) {
            new Notification(`Debt Due: ${debt.entity}`, {
                body: `You owe $${debt.amount.toFixed(2)}. Due on ${debt.dueDate}.`,
                tag: debt.id
            });
            debt.reminderSent = true; // evita repetir la misma notificación cada 60s
        }
    });
    save(false); // persistimos reminderSent sin re-renderizar innecesariamente
    checkCardReminders();
}

// --- RENDERING ---
function render() {
    list.innerHTML = '';
    let total = 0;

    debts.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    debts.forEach(debt => {
        if (debt.status === 'pending') total += debt.amount;
        const isPaid = debt.status === 'paid';

        const li = document.createElement('li');
        li.className = 'ledger-row' + (isPaid ? ' is-paid' : '');

        li.innerHTML = `
            <div class="row-main">
                <h3 class="entity">${debt.entity}</h3>
                <p class="due">Due ${debt.dueDate}${debt.recurrence ? ' <span class="recur-badge">↻ recurrente</span>' : ''}</p>
            </div>
            <div class="row-amount">
                <span class="amount">$${debt.amount.toFixed(2)}</span>
                <div class="row-actions">
                    <button class="link-edit" onclick="editDebt('${debt.id}')">Editar</button>
                    <button class="link-pay" onclick="togglePaid('${debt.id}')">${isPaid ? 'Undo' : 'Mark paid'}</button>
                    <button class="link-del" onclick="deleteDebt('${debt.id}')">Delete</button>
                </div>
            </div>
        `;
        if (debt.id === editingId) li.classList.add('is-editing');
        list.appendChild(li);
    });

    totalEl.textContent = `Total Owed: $${total.toFixed(2)}`;
}

// --- ACTIONS ---
function save(shouldRender = true) {
    localStorage.setItem('debts', JSON.stringify(debts));
    if (shouldRender) render();
}

form.addEventListener('submit', (e) => {
    e.preventDefault();

    // Fix #3: amount se guarda como número (parseFloat), no como string.
    const amountValue = parseFloat(document.getElementById('amount').value);
    if (Number.isNaN(amountValue)) {
        alert('Monto inválido.');
        return;
    }

    let recurrence = null;
    if (repeatsSelect.value === 'monthly') {
        const dueDateObj = parseDateStr(document.getElementById('due-date').value);
        recurrence = { type: 'monthly', day: dueDateObj.getDate() };
    } else if (repeatsSelect.value === 'custom-days') {
        if (selectedDays.size === 0) {
            alert('Elige al menos un día del mes para la recurrencia.');
            return;
        }
        recurrence = { type: 'custom-days', days: Array.from(selectedDays) };
    }

    const editingDebt = editingId ? debts.find(d => d.id === editingId) : null;

    if (editingDebt) {
        // Actualiza la deuda existente en lugar de crear una nueva
        editingDebt.entity = document.getElementById('entity').value;
        editingDebt.amount = amountValue;
        editingDebt.dueDate = document.getElementById('due-date').value;
        editingDebt.reminderDate = document.getElementById('reminder-date').value || null;
        editingDebt.reminderSent = false; // si cambió la fecha, permite que vuelva a avisar
        editingDebt.recurrence = recurrence;
    } else {
        debts.push({
            id: crypto.randomUUID(),
            entity: document.getElementById('entity').value,
            amount: amountValue,
            dueDate: document.getElementById('due-date').value,
            reminderDate: document.getElementById('reminder-date').value || null,
            reminderSent: false,
            status: 'pending',
            recurrence,
            nextGenerated: false
        });
    }

    save();
    form.reset();
    customDaysField.hidden = true;
    resetDayPicker();
    exitEditMode();
});

// --- MODO EDICIÓN ---
function exitEditMode() {
    editingId = null;
    submitBtn.textContent = 'Add Debt';
    cancelEditBtn.hidden = true;
}

window.editDebt = (id) => {
    const debt = debts.find(d => d.id === id);
    if (!debt) return;

    editingId = id;

    document.getElementById('entity').value = debt.entity;
    document.getElementById('amount').value = debt.amount;
    document.getElementById('due-date').value = debt.dueDate;
    document.getElementById('reminder-date').value = debt.reminderDate || '';

    resetDayPicker();
    if (debt.recurrence && debt.recurrence.type === 'monthly') {
        repeatsSelect.value = 'monthly';
        customDaysField.hidden = true;
    } else if (debt.recurrence && debt.recurrence.type === 'custom-days') {
        repeatsSelect.value = 'custom-days';
        customDaysField.hidden = false;
        debt.recurrence.days.forEach(d => {
            selectedDays.add(d);
            const btn = dayPicker.querySelector(`button[data-day="${d}"]`);
            if (btn) btn.classList.add('selected');
        });
    } else {
        repeatsSelect.value = 'none';
        customDaysField.hidden = true;
    }

    submitBtn.textContent = 'Guardar cambios';
    cancelEditBtn.hidden = false;

    render(); // resalta el renglón en edición
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('entity').focus();
};

cancelEditBtn.addEventListener('click', () => {
    form.reset();
    customDaysField.hidden = true;
    resetDayPicker();
    exitEditMode();
    render();
});

window.togglePaid = (id) => {
    const debt = debts.find(d => d.id === id);
    const wasPending = debt.status === 'pending';
    debt.status = wasPending ? 'paid' : 'pending';

    // Al pagar una deuda recurrente (y solo la primera vez que se paga),
    // se genera automáticamente la siguiente ocurrencia como pendiente.
    if (wasPending && debt.recurrence && !debt.nextGenerated) {
        const nextDueDate = getNextDueDate(debt.dueDate, debt.recurrence);
        if (nextDueDate) {
            debts.push({
                id: crypto.randomUUID(),
                entity: debt.entity,
                amount: debt.amount,
                dueDate: nextDueDate,
                reminderDate: getNextReminderDate(debt.dueDate, debt.reminderDate, nextDueDate),
                reminderSent: false,
                status: 'pending',
                recurrence: debt.recurrence,
                nextGenerated: false
            });
            debt.nextGenerated = true;
        }
    }
    save();
};

window.deleteDebt = (id) => {
    if (confirm('Delete this debt?')) {
        debts = debts.filter(d => d.id !== id);
        save();
    }
};

// --- PESTAÑAS: DEUDAS / GASTOS ---
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = {
    debts: document.getElementById('tab-debts'),
    expenses: document.getElementById('tab-expenses')
};
tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        tabButtons.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        Object.entries(tabPanels).forEach(([key, panel]) => {
            panel.hidden = key !== btn.dataset.tab;
        });
    });
});

// --- BOTÓN DE ACTUALIZAR / LIMPIAR CACHÉ ---
// Fix #1 (parte cliente): permite forzar la baja de la versión cacheada
// sin esperar a que expire, útil mientras iteras rápido en el SW network-first.
btnClearCache.addEventListener('click', async () => {
    if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) await reg.unregister();
    }
    if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
    }
    location.reload();
});

// ============================================================
// ================== GASTOS (Alimentos, Gasolina, Servicios) ===
// ============================================================
const CATEGORY_META = {
    alimentos:   { label: 'Alimentos',              defaultCard: 'StG99' },
    gasolina:    { label: 'Gasolina',                defaultCard: 'Globank' },
    agua:        { label: 'Agua',                    defaultCard: 'Bgral' },
    luz:         { label: 'Naturgy (luz)',            defaultCard: 'Bgral' },
    internet_tv: { label: 'Masmovil (internet/TV)',   defaultCard: 'Bgral' },
    data:        { label: 'Masmovil (data)',          defaultCard: 'Bgral' }
};

let expenses = [];
try {
    expenses = JSON.parse(localStorage.getItem('expenses')) || [];
} catch (err) {
    console.error('expenses corrupto en localStorage, reiniciando lista:', err);
    expenses = [];
}

// --- CONFIGURACIÓN DE TARJETAS: fecha de corte + fecha del último pago ---
// "Debo en la tarjeta" = suma de gastos con esa tarjeta desde la última vez
// marcada como pagada (o desde siempre, si nunca se ha marcado).
let cardsConfig = {};
try {
    cardsConfig = JSON.parse(localStorage.getItem('cardsConfig')) || {};
} catch (err) {
    console.error('cardsConfig corrupto en localStorage, reiniciando:', err);
    cardsConfig = {};
}
['Bgral', 'StG99', 'Globank'].forEach(name => {
    if (!cardsConfig[name]) {
        cardsConfig[name] = { cutoffDay: null, lastPaymentDate: null, lastReminderCycle: null };
    }
});

function saveCardsConfig() {
    localStorage.setItem('cardsConfig', JSON.stringify(cardsConfig));
}

function cardBalance(cardName) {
    const cfg = cardsConfig[cardName];
    const since = cfg.lastPaymentDate ? parseDateStr(cfg.lastPaymentDate) : null;
    return expenses
        .filter(e => e.card === cardName && (!since || parseDateStr(e.date) > since))
        .reduce((sum, e) => sum + e.amount, 0);
}

// Notificación un día antes de la fecha de corte de cada tarjeta.
// Se apoya en el mismo intervalo de 60s que ya revisa los recordatorios de deudas.
function checkCardReminders() {
    if (Notification.permission !== 'granted') return;
    const now = new Date();
    const todayStr = formatDateStr(now);

    Object.entries(cardsConfig).forEach(([cardName, cfg]) => {
        if (!cfg.cutoffDay) return;

        const cutoffDate = new Date(now.getFullYear(), now.getMonth(), clampDay(now.getFullYear(), now.getMonth(), cfg.cutoffDay));
        const reminderDate = new Date(cutoffDate);
        reminderDate.setDate(reminderDate.getDate() - 1);

        const cycleKey = `${now.getFullYear()}-${now.getMonth()}`;
        if (todayStr === formatDateStr(reminderDate) && cfg.lastReminderCycle !== cycleKey) {
            new Notification(`Corte de ${cardName} mañana`, {
                body: `Mañana es la fecha de corte de ${cardName}. Saldo actual: $${cardBalance(cardName).toFixed(2)}.`,
                tag: `card-cutoff-${cardName}`
            });
            cfg.lastReminderCycle = cycleKey;
            saveCardsConfig();
        }
    });
}

const cardButtons = document.querySelectorAll('.card-btn');
const cardDetail = document.getElementById('card-detail');
const cardDetailAmount = document.getElementById('card-detail-amount');
const cardDetailName = document.getElementById('card-detail-name');
const cardDetailMeta = document.getElementById('card-detail-meta');
const cardCutoffInput = document.getElementById('card-cutoff-day');
const cardMarkPaidBtn = document.getElementById('card-mark-paid-btn');
let selectedCard = null;

function renderCardDetail() {
    if (!selectedCard) {
        cardDetail.hidden = true;
        return;
    }
    const cfg = cardsConfig[selectedCard];
    cardDetail.hidden = false;
    cardDetailName.textContent = selectedCard;
    cardDetailAmount.textContent = `$${cardBalance(selectedCard).toFixed(2)}`;
    cardCutoffInput.value = cfg.cutoffDay || '';
    cardDetailMeta.textContent = cfg.lastPaymentDate
        ? `Última vez marcada como pagada: ${cfg.lastPaymentDate}`
        : 'Aún no se ha marcado como pagada.';
}

cardButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const card = btn.dataset.card;
        selectedCard = selectedCard === card ? null : card; // toca de nuevo para cerrar
        cardButtons.forEach(b => b.classList.toggle('active', b.dataset.card === selectedCard));
        renderCardDetail();
    });
});

cardCutoffInput.addEventListener('change', () => {
    if (!selectedCard) return;
    const val = parseInt(cardCutoffInput.value, 10);
    cardsConfig[selectedCard].cutoffDay = Number.isNaN(val) ? null : Math.min(Math.max(val, 1), 31);
    saveCardsConfig();
});

cardMarkPaidBtn.addEventListener('click', () => {
    if (!selectedCard) return;
    if (!confirm(`¿Marcar ${selectedCard} como pagada hoy? El saldo pendiente quedará en $0 a partir de hoy.`)) return;
    cardsConfig[selectedCard].lastPaymentDate = formatDateStr(new Date());
    saveCardsConfig();
    renderCardDetail();
});

const expenseForm = document.getElementById('expense-form');
const expenseList = document.getElementById('expense-list');
const expenseCategorySelect = document.getElementById('expense-category');
const expenseCardSelect = document.getElementById('expense-card');
const expenseSubmitBtn = document.getElementById('expense-submit-btn');
const expenseCancelEditBtn = document.getElementById('expense-cancel-edit-btn');
const prevMonthBtn = document.getElementById('prev-month');
const nextMonthBtn = document.getElementById('next-month');
const currentMonthLabel = document.getElementById('current-month-label');
const summaryByCard = document.getElementById('summary-by-card');
const summaryByCategory = document.getElementById('summary-by-category');

let editingExpenseId = null;
let viewedMonth = new Date(); // primer día del mes que se está viendo
viewedMonth.setDate(1);

const MONTH_FORMATTER = new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric' });

document.getElementById('expense-date').value = formatDateStr(new Date());

// Autocompleta la tarjeta sugerida al elegir el rubro (editable después)
expenseCategorySelect.addEventListener('change', () => {
    const meta = CATEGORY_META[expenseCategorySelect.value];
    if (meta) expenseCardSelect.value = meta.defaultCard;
});
expenseCardSelect.value = CATEGORY_META[expenseCategorySelect.value].defaultCard;

function saveExpenses() {
    localStorage.setItem('expenses', JSON.stringify(expenses));
    renderExpenses();
    renderCardDetail();
}

function expensesForViewedMonth() {
    const y = viewedMonth.getFullYear();
    const m = viewedMonth.getMonth();
    return expenses.filter(e => {
        const d = parseDateStr(e.date);
        return d.getFullYear() === y && d.getMonth() === m;
    });
}

function renderExpenses() {
    currentMonthLabel.textContent = MONTH_FORMATTER.format(viewedMonth);

    const monthExpenses = expensesForViewedMonth()
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    // --- Resúmenes ---
    const totalsByCard = {};
    const totalsByCategory = {};
    monthExpenses.forEach(e => {
        totalsByCard[e.card] = (totalsByCard[e.card] || 0) + e.amount;
        totalsByCategory[e.category] = (totalsByCategory[e.category] || 0) + e.amount;
    });

    summaryByCard.innerHTML = Object.keys(totalsByCard).length
        ? Object.entries(totalsByCard)
            .sort((a, b) => b[1] - a[1])
            .map(([card, total]) => `<li><span>${card}</span><span class="summary-amount">$${total.toFixed(2)}</span></li>`)
            .join('')
        : '<li class="summary-empty">Sin gastos este mes</li>';

    summaryByCategory.innerHTML = Object.keys(totalsByCategory).length
        ? Object.entries(totalsByCategory)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, total]) => `<li><span>${CATEGORY_META[cat].label}</span><span class="summary-amount">$${total.toFixed(2)}</span></li>`)
            .join('')
        : '<li class="summary-empty">Sin gastos este mes</li>';

    // --- Lista de renglones ---
    expenseList.innerHTML = '';
    monthExpenses.forEach(e => {
        const li = document.createElement('li');
        li.className = 'ledger-row';
        if (e.id === editingExpenseId) li.classList.add('is-editing');

        li.innerHTML = `
            <div class="row-main">
                <h3 class="entity">${CATEGORY_META[e.category].label}<span class="card-tag" data-card="${e.card}">${e.card}</span></h3>
                <p class="due">${e.date}${e.note ? ' · ' + e.note : ''}</p>
            </div>
            <div class="row-amount">
                <span class="amount">$${e.amount.toFixed(2)}</span>
                <div class="row-actions">
                    <button class="link-edit" onclick="editExpense('${e.id}')">Editar</button>
                    <button class="link-del" onclick="deleteExpense('${e.id}')">Delete</button>
                </div>
            </div>
        `;
        expenseList.appendChild(li);
    });
}

expenseForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const amountValue = parseFloat(document.getElementById('expense-amount').value);
    if (Number.isNaN(amountValue)) {
        alert('Monto inválido.');
        return;
    }

    const data = {
        category: expenseCategorySelect.value,
        card: expenseCardSelect.value,
        amount: amountValue,
        date: document.getElementById('expense-date').value,
        note: document.getElementById('expense-note').value || null
    };

    if (editingExpenseId) {
        const existing = expenses.find(x => x.id === editingExpenseId);
        Object.assign(existing, data);
    } else {
        expenses.push({ id: crypto.randomUUID(), ...data });
    }

    saveExpenses();
    expenseForm.reset();
    document.getElementById('expense-date').value = formatDateStr(new Date());
    expenseCardSelect.value = CATEGORY_META[expenseCategorySelect.value].defaultCard;
    exitExpenseEditMode();
});

function exitExpenseEditMode() {
    editingExpenseId = null;
    expenseSubmitBtn.textContent = 'Add Expense';
    expenseCancelEditBtn.hidden = true;
}

window.editExpense = (id) => {
    const expense = expenses.find(x => x.id === id);
    if (!expense) return;

    editingExpenseId = id;
    expenseCategorySelect.value = expense.category;
    expenseCardSelect.value = expense.card;
    document.getElementById('expense-amount').value = expense.amount;
    document.getElementById('expense-date').value = expense.date;
    document.getElementById('expense-note').value = expense.note || '';

    expenseSubmitBtn.textContent = 'Guardar cambios';
    expenseCancelEditBtn.hidden = false;

    renderExpenses();
    expenseForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

expenseCancelEditBtn.addEventListener('click', () => {
    expenseForm.reset();
    document.getElementById('expense-date').value = formatDateStr(new Date());
    expenseCardSelect.value = CATEGORY_META[expenseCategorySelect.value].defaultCard;
    exitExpenseEditMode();
    renderExpenses();
});

window.deleteExpense = (id) => {
    if (confirm('Delete this expense?')) {
        expenses = expenses.filter(x => x.id !== id);
        saveExpenses();
    }
};

prevMonthBtn.addEventListener('click', () => {
    viewedMonth.setMonth(viewedMonth.getMonth() - 1);
    renderExpenses();
});
nextMonthBtn.addEventListener('click', () => {
    viewedMonth.setMonth(viewedMonth.getMonth() + 1);
    renderExpenses();
});

renderExpenses();
renderCardDetail();

// --- INIT ---
render();
initNotifications();

// --- REGISTRO DEL SERVICE WORKER ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
}
