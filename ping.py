import eel
import random
import time
import threading

eel.init('web')

# Global variable for interval
current_interval = 200
update_thread = None
should_run = True
js_is_ready = False

@eel.expose
def get_ping_data():
    # Simulated data
    latency = random.randint(20, 50)
    jitter = random.randint(1, 5)
    packetLoss = round(random.uniform(0, 0.2), 2)
    return {'latency': latency, 'jitter': jitter, 'packetLoss': packetLoss}

def update_loop():
    global should_run, js_is_ready
    while not js_is_ready:
        time.sleep(0.1)  # Wait briefly for JS to be ready

    while should_run:
        try:
            pingData = get_ping_data()
            eel.set_data(pingData['latency'], pingData['jitter'], pingData['packetLoss'])
            print(f"Updated data with interval: {current_interval}ms")
            time.sleep(current_interval / 1000)
        except Exception as e:  # Catch exceptions for robustness
            print(f"Error in update_loop: {e}")
            break

@eel.expose
def set_interval(new_interval):
    global current_interval, update_thread, should_run

    print(f"Received new interval: {new_interval}ms")
    current_interval = new_interval

    # Stop existing thread
    if update_thread and update_thread.is_alive():
        should_run = False
        update_thread.join()  # Wait for the thread to finish
        update_thread = None  # Reset to None after joining

    # Start new thread
    should_run = True
    update_thread = threading.Thread(target=update_loop)
    update_thread.start()
    print(f"Started new update thread with interval: {current_interval}ms")
    return True

@eel.expose
def js_ready():
    global js_is_ready
    print("JavaScript is ready!")
    js_is_ready = True

# Start initial update loop
def start_update_loop():
    global update_thread
    update_thread = threading.Thread(target=update_loop)
    update_thread.start()

eel.spawn(start_update_loop)  # Use eel.spawn to start after setup
eel.start('index.html')