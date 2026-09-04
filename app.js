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

// --- INIT ---
render();
initNotifications();

// --- REGISTRO DEL SERVICE WORKER ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
}
