const { ipcRenderer } = require('electron');

let allTransfers = [];

// Tab switching controller
function switchTab(tabName) {
    document.getElementById('squad-tab').style.display = tabName === 'squad' ? 'block' : 'none';
    document.getElementById('transfers-tab').style.display = tabName === 'transfers' ? 'block' : 'none';
    
    document.getElementById('btn-squad').classList.toggle('active', tabName === 'squad');
    document.getElementById('btn-transfers').classList.toggle('active', tabName === 'transfers');
}

// Format numbers into clean currency strings (e.g., €45.5M)
function formatMoney(amount) {
    if (amount >= 1000000) {
        return `€${(amount / 1000000).toFixed(1)}M`;
    } else if (amount > 0) {
        return `€${(amount / 1000).toFixed(0)}K`;
    }
    return 'Free / Loan';
}

// Listen for Squad updates from main.js
ipcRenderer.on('update-squad-data', (event, jsonData) => {
    const data = JSON.parse(jsonData);
    const tbody = document.getElementById('squad-tbody');
    tbody.innerHTML = '';

    if (!data.players || data.players.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: #666;">No squad data found.</td></tr>`;
        return;
    }

    data.players.forEach(p => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${p.name}</strong></td>
            <td>${p.position_id}</td>
            <td>${p.overall}</td>
            <td>${p.appearances}</td>
            <td>${p.goals}</td>
            <td>${p.assists}</td>
            <td>${p.clean_sheets}</td>
            <td>${p.yellow_cards}</td>
            <td>${p.red_cards}</td>
            <td>${p.avg_rating.toFixed(2)}</td>
        `;
        tbody.appendChild(row);
    });
});

// Listen for Transfer updates from main.js
ipcRenderer.on('update-transfer-data', (event, jsonData) => {
    const data = JSON.parse(jsonData);
    allTransfers = data.transfers || [];
    filterTransfers();
});

// Filter logic for Transfers Hub dropdown
function filterTransfers() {
    const filterValue = document.getElementById('transfer-filter').value;
    const tbody = document.getElementById('transfers-tbody');
    tbody.innerHTML = '';

    let filtered = allTransfers.filter(t => {
        if (filterValue === 'my_team') return t.is_user;
        if (filterValue === 'league') return t.is_league;
        if (filterValue === 'big_money') return t.is_big_money;
        return true;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #666;">No transfers found for this filter.</td></tr>`;
        return;
    }

    filtered.forEach(t => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${t.player_name}</strong></td>
            <td>${t.from_team}</td>
            <td>${t.to_team}</td>
            <td style="color: #10b981; font-weight: 600;">${formatMoney(t.fee)}</td>
        `;
        tbody.appendChild(row);
    });
}