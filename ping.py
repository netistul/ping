import webview
from webview.dom import DOMEventHandler
import pkg_resources
version = pkg_resources.get_distribution('pywebview').version
print("pywebview version:", version)
import os
import threading
import time
import platform
import subprocess
import re
import statistics
import json
from typing import List, Dict

class API:
    def __init__(self, window):
        self.window = window
        self.current_interval = 200
        self.update_thread = None
        self.should_run = True
        self.js_is_ready = False
        self.TARGET_HOST = "8.8.8.8"
        self.PING_COUNT = 3

    def get_ping_data(self):
        """Get ping metrics and return as JSON string"""
        return json.dumps(self.ping_host())
    
    def ping_host(self) -> Dict[str, float]:
        """
        Ping the target host and return latency, jitter, and packet loss metrics
        """
        try:
            # Determine OS-specific ping command
            if platform.system().lower() == "windows":
                ping_cmd = ["ping", "-n", str(self.PING_COUNT), self.TARGET_HOST]
            else:  # Linux and MacOS
                ping_cmd = ["ping", "-c", str(self.PING_COUNT), self.TARGET_HOST]
            
            result = subprocess.run(ping_cmd, capture_output=True, text=True)
            
            if result.returncode != 0:
                raise Exception("Ping failed")
            
            times: List[float] = []
            output = result.stdout.lower()
            
            if platform.system().lower() == "windows":
                # Parse Windows ping output
                for line in output.split('\n'):
                    if "time=" in line or "time<" in line:
                        try:
                            time_str = re.search(r"time[<=](\d+)ms", line)
                            if time_str:
                                times.append(float(time_str.group(1)))
                        except:
                            continue
                
                loss_match = re.search(r"(\d+)% loss", output)
                packet_loss = float(loss_match.group(1)) if loss_match else 0
                
            else:
                # Parse Linux/MacOS ping output
                for line in output.split('\n'):
                    if "time=" in line:
                        try:
                            time_str = re.search(r"time=([\d.]+)", line)
                            if time_str:
                                times.append(float(time_str.group(1)))
                        except:
                            continue
                
                loss_match = re.search(r"(\d+)% packet loss", output)
                packet_loss = float(loss_match.group(1)) if loss_match else 0
            
            if not times:
                raise Exception("No valid ping times found")
            
            latency = statistics.mean(times)
            jitter = statistics.stdev(times) if len(times) > 1 else 0
            
            return {
                'latency': round(latency, 1),
                'jitter': round(jitter, 1),
                'packetLoss': round(packet_loss, 1)
            }
            
        except Exception as e:
            print(f"Error during ping: {str(e)}")
            return {
                'latency': 0,
                'jitter': 0,
                'packetLoss': 100
            }

    def set_interval(self, new_interval):
        """Update the ping interval"""
        print(f"Received new interval: {new_interval}ms")
        self.current_interval = new_interval
        
        if self.update_thread and self.update_thread.is_alive():
            self.should_run = False
            self.update_thread.join()
            self.update_thread = None
        
        self.should_run = True
        self.update_thread = threading.Thread(target=self.update_loop)
        self.update_thread.daemon = True
        self.update_thread.start()
        print(f"Started new update thread with interval: {self.current_interval}ms")
        return json.dumps({"success": True})

    def js_ready(self):
        """Signal that JavaScript is ready"""
        print("JavaScript is ready!")
        self.js_is_ready = True
        
        # Send an initial ping data to kickstart the UI
        try:
            if self.window:
                ping_data = self.ping_host()
                js_command = f'if(typeof window.updateMetrics === "function") {{ window.updateMetrics({json.dumps(ping_data)}); }}'
                self.window.evaluate_js(js_command)
        except Exception as e:
            print(f"Error sending initial data: {e}")
        
        return json.dumps({"success": True})

    def update_loop(self):
        print("Starting update loop...")
        
        # Initial delay to give JS time to initialize basic components
        time.sleep(0.5)
        
        while self.should_run:
            try:
                # Get ping data
                ping_data = self.ping_host()
                
                # Check if window exists before trying to use it
                if self.window:
                    # First try direct metrics update
                    try:
                        js_command = f'if(typeof window.updateMetrics === "function") {{ window.updateMetrics({json.dumps(ping_data)}); }}'
                        self.window.evaluate_js(js_command)
                    except Exception as e:
                        # Fallback to updating individual values
                        try:
                            js_command = f'if(typeof window.updateDisplayValues === "function") {{ window.updateDisplayValues({ping_data["latency"]}, {ping_data["jitter"]}, {ping_data["packetLoss"]}); }}'
                            self.window.evaluate_js(js_command)
                        except Exception as inner_e:
                            print(f"Failed to update UI: {inner_e}")
                
                time.sleep(self.current_interval / 1000)
            except Exception as e:
                print(f"Error in update_loop: {str(e)}")
                time.sleep(1)

    def minimize_window(self):
        """Minimize the window"""
        self.window.minimize()
        return json.dumps({"success": True})

    def maximize_window(self):
        """Maximize the window"""
        self.window.toggle_fullscreen()
        return json.dumps({"success": True})

    def restore_window(self):
        """Restore the window from maximized state"""
        self.window.toggle_fullscreen()
        return json.dumps({"success": True})

    def close_window(self):
        """Close the window"""
        self.window.destroy()
        return json.dumps({"success": True})
    
# Main application code
def main():
    # First create the window
    window = webview.create_window(
        'Network Monitor',
        url=os.path.join(os.path.dirname(__file__), 'web', 'index.html'),
        width=1050,
        height=670,
        min_size=(800, 650),
        frameless=True
    )
    
    # Create the API instance
    api = API(window)
    
    # Expose individual methods using the window object
    window.expose(api.get_ping_data)
    window.expose(api.set_interval)
    window.expose(api.js_ready)
    
    window.expose(api.minimize_window)
    window.expose(api.maximize_window)
    window.expose(api.restore_window)
    window.expose(api.close_window)

    # Start the update thread
    api.update_thread = threading.Thread(target=api.update_loop)
    api.update_thread.daemon = True
    api.update_thread.start()
    
    # Start the application
    webview.start(debug=True)


if __name__ == '__main__':
    main()